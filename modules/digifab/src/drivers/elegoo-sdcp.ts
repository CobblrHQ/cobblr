// Elegoo SDCP driver — Centauri Carbon (and other SDCP V3 printers) over the
// printer's OWN network services: UDP discovery on :3000, a JSON WebSocket on
// :3030/websocket for commands/status, and chunked multipart HTTP upload on
// :3030/uploadFile/upload. No auth (the printer offers none — LAN-only by
// design; the SSRF guard still vets the host).
//
// ⚠ HARDWARE-UNVERIFIED (like the LightBurn driver): written against the SDCP
// V3.0.0 protocol as implemented by the `sdcp` npm library and the MIT
// print-farm-manager Elegoo driver (incl. its field-observed status codes and
// the full Cmd-128 start payload the Centauri Carbon firmware requires — the
// minimal {Filename, StartLayer} payload crashes it). No npm dep: Node 22's
// global WebSocket/fetch/FormData + node:dgram/crypto cover the whole protocol.
//
// Single-printer driver: one connection = one printer (listDevices returns 1).
// Job identity: SDCP reports no job id, so the uploaded FILENAME is the job id
// and status is inferred from the printer's PrintInfo — same approach as the
// other single-printer paths.

import { createSocket } from "node:dgram";
import { createHash, randomBytes } from "node:crypto";
import type {
  ConnectionResult,
  JobStatus,
  MachineDriver,
  ManagerConfig,
  PlacementResolution,
  RemoteDevice,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";
import { assertSafeMachineUrl } from "./ssrf.js";

const DISCOVER_PORT = 3000;
const WS_PORT = 3030;
const DISCOVER_TIMEOUT_MS = 4_000;
const WS_TIMEOUT_MS = 10_000;
const UPLOAD_CHUNK = 1024 * 1024; // 1 MB — the sdcp lib's chunk size

// PrintInfo.Status → canonical state. Codes from the SDCP V3 spec plus the
// print-farm-manager driver's field-observed Centauri Carbon codes (9/13/16/
// 18/21). Unknown codes map to "unknown", never to an error — a stray
// transient code must not fail a live print.
function mapPrintState(code: number | undefined): JobStatus["state"] {
  switch (code) {
    case 0:
      return "completed"; // idle — see getJobStatus for the idle-vs-done call
    case 1:
    case 13:
    case 16:
    case 18:
    case 21:
      return "printing";
    case 2:
      return "paused";
    case 3: // user-stopped
      return "cancelled";
    case 4:
    case 9:
      return "completed";
    default:
      return "unknown";
  }
}

/** Human strings for the Cmd-128 start Ack codes (0 = ok). */
const START_ACK_ERRORS: Record<number, string> = {
  1: "device busy",
  2: "file not found on printer",
  3: "MD5 checksum mismatch",
  4: "file read failed",
  5: "file resolution mismatch",
  6: "unknown file format or model mismatch",
};

type SdcpStatus = {
  PrintInfo?: {
    Status?: number;
    Progress?: number;
    CurrentTicks?: number;
    TotalTicks?: number;
    RemainTime?: number;
    Filename?: string;
  };
  CurrentStatus?: number[] | number;
  TempOfNozzle?: number;
  TempTargetNozzle?: number;
  TempOfHotbed?: number;
  TempTargetHotbed?: number;
};

export class ElegooSdcpDriver implements MachineDriver {
  private readonly host: string;
  private board: { id: string; mainboardId: string; name: string } | null = null;

  constructor(cfg: ManagerConfig) {
    // Accept http(s)://ip, elegoo://ip, or a bare ip/hostname.
    const m = /^(?:[a-z+]+:\/\/)?([^/:]+)/i.exec(cfg.baseUrl.trim());
    this.host = m?.[1] ?? cfg.baseUrl.trim();
  }

  private async guard(): Promise<void> {
    await assertSafeMachineUrl(`http://${this.host}:${WS_PORT}/`);
  }

  /** UDP discovery: "M99999" to :3000 → JSON { Id, Data: { MainboardID, Name … } }.
   *  This is how SDCP clients learn the ids every WS request must carry. */
  private async discover(): Promise<{ id: string; mainboardId: string; name: string }> {
    if (this.board) return this.board;
    await this.guard();
    const found = await new Promise<{ id: string; mainboardId: string; name: string }>((resolve, reject) => {
      const sock = createSocket("udp4");
      const timer = setTimeout(() => {
        sock.close();
        reject(new Error(`no SDCP discovery reply from ${this.host}:${DISCOVER_PORT}`));
      }, DISCOVER_TIMEOUT_MS);
      sock.on("message", (msg) => {
        try {
          const j = JSON.parse(msg.toString()) as { Id?: string; Data?: { MainboardID?: string; Name?: string; MachineName?: string } };
          clearTimeout(timer);
          sock.close();
          resolve({
            id: j.Id ?? "",
            mainboardId: j.Data?.MainboardID ?? "",
            name: j.Data?.Name ?? j.Data?.MachineName ?? "Elegoo printer",
          });
        } catch {
          /* not our datagram — keep listening until timeout */
        }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        sock.close();
        reject(e);
      });
      sock.send("M99999", DISCOVER_PORT, this.host);
    });
    this.board = found;
    return found;
  }

  /** One WS request/response round-trip: connect, send the SDCP envelope, wait
   *  for the matching RequestID, close. Short-lived by design — the poll loop
   *  calls this every ~30s and a persistent socket buys nothing but state. */
  private async wsCommand(cmd: number, data: Record<string, unknown> = {}): Promise<{ ack: number | undefined; status: SdcpStatus | null; raw: unknown }> {
    const board = await this.discover();
    const requestId = randomBytes(16).toString("hex");
    const envelope = {
      Id: board.id,
      Data: {
        Cmd: cmd,
        Data: data,
        RequestID: requestId,
        MainboardID: board.mainboardId,
        Timestamp: Math.floor(Date.now() / 1000),
        From: 0, // PC client
      },
      Topic: `sdcp/request/${board.mainboardId}`,
    };
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${WS_PORT}/websocket`);
      let lastStatus: SdcpStatus | null = null;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`SDCP request timed out (cmd ${cmd})`));
      }, WS_TIMEOUT_MS);
      const done = (ack: number | undefined, raw: unknown) => {
        clearTimeout(timer);
        ws.close();
        resolve({ ack, status: lastStatus, raw });
      };
      ws.addEventListener("open", () => ws.send(JSON.stringify(envelope)));
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`SDCP websocket to ${this.host}:${WS_PORT} failed`));
      });
      ws.addEventListener("message", (ev) => {
        try {
          const j = JSON.parse(String(ev.data)) as {
            Topic?: string;
            Status?: SdcpStatus;
            Data?: { RequestID?: string; Data?: { Ack?: number } };
          };
          // The printer pushes status frames on its own; keep the freshest.
          if (j.Topic === `sdcp/status/${board.mainboardId}` && j.Status) lastStatus = j.Status;
          if (j.Data?.RequestID === requestId) {
            // A status REQUEST (cmd 0) is answered by a status push; give it a
            // beat to arrive if it hasn't already.
            if (cmd === 0 && !lastStatus) {
              setTimeout(() => done(j.Data?.Data?.Ack, j), 400);
            } else {
              done(j.Data?.Data?.Ack, j);
            }
          }
        } catch {
          /* non-JSON frame — ignore */
        }
      });
    });
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const board = await this.discover();
      await this.wsCommand(0);
      return { ok: true, detail: `${board.name} (${board.mainboardId.slice(0, 8)}…)`, capabilities: { routing: false } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, capabilities: { routing: false } };
    }
  }

  async listDevices(): Promise<RemoteDevice[]> {
    const board = await this.discover();
    let st: SdcpStatus | null = null;
    try {
      st = (await this.wsCommand(0)).status;
    } catch {
      return [{ id: board.mainboardId, name: board.name, enabled: true, state: "offline" }];
    }
    const code = st?.PrintInfo?.Status ?? (Array.isArray(st?.CurrentStatus) ? st?.CurrentStatus[0] : st?.CurrentStatus);
    const printing = mapPrintState(typeof code === "number" ? code : undefined) === "printing";
    return [
      {
        id: board.mainboardId,
        name: board.name,
        enabled: true,
        state: printing ? "printing" : "operational",
        temps: st
          ? {
              nozzle: st.TempOfNozzle != null ? { actual: st.TempOfNozzle, target: st.TempTargetNozzle } : null,
              bed: st.TempOfHotbed != null ? { actual: st.TempOfHotbed, target: st.TempTargetHotbed } : null,
            }
          : null,
        job:
          printing && st?.PrintInfo
            ? {
                fractionPrinted:
                  st.PrintInfo.CurrentTicks != null && st.PrintInfo.TotalTicks
                    ? st.PrintInfo.CurrentTicks / st.PrintInfo.TotalTicks
                    : undefined,
                timeLeftSec: st.PrintInfo.RemainTime ?? undefined,
              }
            : null,
        raw: (st as Record<string, unknown> | null) ?? null,
      },
    ];
  }

  async setDeviceEnabled(): Promise<void> {
    /* SDCP has no enable/disable — a no-op, like other single-printer drivers */
  }

  /** Chunked multipart upload to :3030/uploadFile/upload — Uuid + Offset +
   *  TotalSize + Check + S-File-MD5 per chunk, exactly the sdcp lib's shape. */
  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    await this.guard();
    const md5 = createHash("md5").update(file).digest("hex");
    const uuid = randomBytes(32).toString("hex");
    for (let offset = 0; offset < file.byteLength; offset += UPLOAD_CHUNK) {
      const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, file.byteLength));
      const form = new FormData();
      form.append("Uuid", uuid);
      form.append("Offset", String(offset));
      form.append("TotalSize", String(file.byteLength));
      form.append("Check", "1");
      form.append("S-File-MD5", md5);
      form.append("File", new Blob([chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer]), filename);
      const res = await fetch(`http://${this.host}:${WS_PORT}/uploadFile/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`SDCP upload failed at offset ${offset}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
    }
    return { fileId: filename, filename };
  }

  async resolvePlacement(): Promise<PlacementResolution> {
    const board = await this.discover();
    return { kind: "printer", matchedName: board.name, deviceIds: [board.mainboardId] };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    const board = await this.discover();
    // Firmware needs a beat between upload-complete and start (per the
    // ElegooSlicer implementation) or Cmd 128 can race the file close.
    await new Promise((r) => setTimeout(r, 1000));
    const { ack } = await this.wsCommand(128, {
      Filename: args.fileId,
      StartLayer: 0,
      // The Centauri Carbon firmware REQUIRES the full payload — the minimal
      // {Filename, StartLayer} the base spec suggests crashes it.
      Calibration_switch: 0,
      PrintPlatformType: 1,
      Tlp_Switch: 0,
      slot_map: [],
    });
    if (ack !== 0) {
      throw new Error(`SDCP start rejected: ${START_ACK_ERRORS[ack ?? -1] ?? `Ack=${ack}`}`);
    }
    return { jobId: args.fileId, deviceId: board.mainboardId, queued: true, status: "queued" };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const board = await this.discover();
    const { status } = await this.wsCommand(0);
    const pi = status?.PrintInfo;
    const code = pi?.Status ?? (Array.isArray(status?.CurrentStatus) ? status?.CurrentStatus[0] : status?.CurrentStatus);
    let state = mapPrintState(typeof code === "number" ? code : undefined);
    // The printer names the running file (often prefixed "<n>_"). If it's
    // printing something ELSE, our job isn't running — with no job history to
    // consult, report the safe reading: completed if the bed went idle after
    // our start, unknown while another file runs.
    const running = pi?.Filename ? pi.Filename.replace(/^\d+_/, "") : null;
    if (state === "printing" && running && running !== jobId) state = "unknown";
    return {
      jobId,
      state,
      progress:
        state === "printing" || state === "paused"
          ? pi?.CurrentTicks != null && pi?.TotalTicks
            ? pi.CurrentTicks / pi.TotalTicks
            : (pi?.Progress ?? null) != null
              ? (pi!.Progress! > 1 ? pi!.Progress! / 100 : pi!.Progress!)
              : null
          : null,
      deviceId: board.mainboardId,
      timeRemainingSec: pi?.RemainTime ?? null,
      raw: status,
    };
  }

  async cancelJob(): Promise<void> {
    const { ack } = await this.wsCommand(130);
    if (ack !== 0) throw new Error(`SDCP stop rejected (Ack=${ack})`);
  }

  async pauseJob(): Promise<void> {
    const { ack } = await this.wsCommand(129);
    if (ack !== 0) throw new Error(`SDCP pause rejected (Ack=${ack})`);
  }

  async resumeJob(): Promise<void> {
    const { ack } = await this.wsCommand(131);
    if (ack !== 0) throw new Error(`SDCP resume rejected (Ack=${ack})`);
  }
}
