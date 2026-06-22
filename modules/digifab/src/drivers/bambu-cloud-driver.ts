// Cloud-Bambu MachineDriver — the live side of a "Bambu Lab" connection in
// CLOUD mode. A connection is an ACCOUNT: listDevices returns EVERY printer on
// the account (each linkable to a machine, the same model as FDM Monster).
// Cloud SUBMIT is blocked by design: Bambu's Authorization Control gates remote
// print-initiation behind their signed clients, so uploads/submits raise a clear
// capability error pointing the user at LAN + Developer Mode. Live telemetry
// (temps/progress) and light/pause/stop come from the hosted MQTT pump; the LAN
// edge-bridge adds full control + camera (per-printer hybrid).
//
// All creds arrive via ManagerConfig.extra.creds (the encrypted blob):
// { region, mode, token, mqttUser, account_email, devices: [{serial, accessCode, name, model}] }.

import type {
  MachineDriver, ManagerConfig, ConnectionResult, RemoteDevice,
  UploadResult, SubmitArgs, SubmitResult, JobStatus, JobState, PlacementResolution,
  ControlDef, CommandResult,
} from "./types.js";
import { BambuCloud, BambuCloudError, type BambuRegion, BAMBU_REGIONS } from "./bambu-cloud.js";
import { publishBambu } from "../bambu-pump.js";

/** Live controls a cloud Bambu exposes over MQTT. The printer's Authorization
 *  Control may still reject them (a printer-side decision); declaring them lets
 *  the UI offer them — a `send` succeeds, "obeyed" is up to the printer. */
const BAMBU_CONTROLS: ControlDef[] = [
  { id: "pause", label: "Pause", kind: "action", group: "print" },
  { id: "resume", label: "Resume", kind: "action", group: "print" },
  { id: "stop", label: "Stop", kind: "action", group: "print", destructive: true },
  { id: "light", label: "Chamber light", kind: "toggle", group: "accessory" },
  { id: "home", label: "Home all", kind: "action", group: "motion" },
  { id: "jog", label: "Move", kind: "jog", group: "motion", axes: ["x", "y", "z"], steps: [1, 10, 50] },
  { id: "nozzle_temp", label: "Nozzle", kind: "number", group: "temperature", unit: "°C", min: 0, max: 300 },
  { id: "bed_temp", label: "Bed", kind: "number", group: "temperature", unit: "°C", min: 0, max: 120 },
];

const CONTROL_BLOCKED =
  "Starting a print over the Bambu cloud isn't allowed — Bambu's Authorization Control " +
  "blocks third-party print initiation. Add LAN access (Developer Mode + edge-bridge) to send jobs.";

/** Bambu cloud print_status → our JobState / device state. */
export function mapCloudPrintStatus(status: string | undefined, online: boolean): string {
  if (!online) return "offline";
  switch (String(status ?? "").toUpperCase()) {
    case "RUNNING": return "printing";
    case "PREPARE":
    case "SLICING": return "printing";
    case "PAUSE": return "paused";
    case "SUCCESS":
    case "FINISH": return "completed";
    case "FAILED": return "failed";
    case "IDLE": return "operational";
    default: return "operational";
  }
}

function coerceRegion(v: unknown): BambuRegion {
  const s = String(v ?? "");
  return (BAMBU_REGIONS as readonly string[]).includes(s) ? (s as BambuRegion) : "North America";
}

interface StoredDevice { serial: string; name?: string; model?: string }

export class BambuCloudDriver implements MachineDriver {
  private region: BambuRegion;
  private token: string;
  private stored: StoredDevice[];
  private cloud: BambuCloud;

  constructor(cfg: ManagerConfig, private connId = "") {
    const c = (cfg.extra?.creds ?? {}) as Record<string, unknown>;
    this.region = coerceRegion(c.region);
    this.token = String(c.token ?? "");
    this.stored = Array.isArray(c.devices)
      ? (c.devices as Record<string, unknown>[]).map((d) => ({ serial: String(d.serial ?? ""), name: typeof d.name === "string" ? d.name : undefined, model: typeof d.model === "string" ? d.model : undefined })).filter((d) => d.serial)
      : [];
    this.cloud = new BambuCloud(this.region);
  }

  async testConnection(): Promise<ConnectionResult> {
    if (!this.token) return { ok: false, detail: "no cloud token stored", capabilities: { routing: false } };
    try {
      await this.cloud.listDevices(this.token);
      return { ok: true, capabilities: { routing: false } };
    } catch (e) {
      const cf = e instanceof BambuCloudError && e.cloudflare;
      return { ok: false, detail: cf ? "Blocked by Bambu's Cloudflare protection" : (e as Error).message, capabilities: { routing: false } };
    }
  }

  /** Every printer on the account, with live cloud state. Falls back to the
   *  stored device list (names/models, state unknown) if the cloud is briefly
   *  unreachable, so links don't disappear from the cockpit. */
  async listDevices(): Promise<RemoteDevice[]> {
    try {
      const devices = await this.cloud.listDevices(this.token);
      if (devices.length) {
        return devices.map((d) => ({
          id: d.dev_id,
          name: d.name,
          enabled: true,
          state: mapCloudPrintStatus(d.print_status, d.online),
          tags: [],
        }));
      }
    } catch {
      // cloud momentarily unreachable → fall back to the stored set as unknown
    }
    return this.stored.map((d) => ({ id: d.serial, name: d.name ?? d.serial, enabled: true, state: "unknown", tags: [] }));
  }

  async setDeviceEnabled(): Promise<void> {
    // No remote enable/disable over cloud; no-op keeps state-sync best-effort.
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    // jobId is the device serial (links carry remote_device_id = serial).
    let state: JobState = "unknown";
    try {
      const devices = await this.cloud.listDevices(this.token);
      const me = devices.find((d) => d.dev_id === jobId);
      if (me) {
        const s = mapCloudPrintStatus(me.print_status, me.online);
        state = (["printing", "paused", "completed", "failed"].includes(s) ? s : "unknown") as JobState;
      }
    } catch { /* unknown on error */ }
    return { jobId, state, deviceId: jobId };
  }

  // ── control (blocked in cloud mode) ──────────────────────────────────────
  async uploadFile(): Promise<UploadResult> { throw new Error(CONTROL_BLOCKED); }
  async submitJob(_args: SubmitArgs): Promise<SubmitResult> { throw new Error(CONTROL_BLOCKED); }
  async resolvePlacement(): Promise<PlacementResolution> {
    return { kind: "none", matchedName: null, deviceIds: [] };
  }

  // Live control over the cloud MQTT the pump holds. STARTING a print is still
  // blocked (file upload is gated) — but pause/resume/stop/jog/light/temps are
  // simple commands the app sends on the same broker, so we offer them.
  listControls(): ControlDef[] {
    return BAMBU_CONTROLS;
  }

  async runControl(deviceId: string, id: string, params: Record<string, unknown>): Promise<CommandResult> {
    const seq = String(Date.now() % 100000);
    const gcode = (g: string) => ({ print: { sequence_id: seq, command: "gcode_line", param: `${g}\n` } });
    let payload: Record<string, unknown> | null = null;
    switch (id) {
      case "pause": payload = { print: { sequence_id: seq, command: "pause" } }; break;
      case "resume": payload = { print: { sequence_id: seq, command: "resume" } }; break;
      case "stop": payload = { print: { sequence_id: seq, command: "stop" } }; break;
      case "light": payload = { system: { sequence_id: seq, command: "ledctrl", led_node: "chamber_light", led_mode: params.on ? "on" : "off" } }; break;
      case "home": payload = gcode("G28"); break;
      case "jog": {
        const axis = String(params.axis ?? "z").toUpperCase();
        const dist = Number(params.dist) || 0;
        payload = gcode(`G91\nG1 ${axis}${dist} F3000\nG90`);
        break;
      }
      case "nozzle_temp": payload = gcode(`M104 S${Math.round(Number(params.value) || 0)}`); break;
      case "bed_temp": payload = gcode(`M140 S${Math.round(Number(params.value) || 0)}`); break;
      default: return { ok: false, detail: `unknown control "${id}"` };
    }
    const sent = publishBambu(this.connId, deviceId, payload);
    return sent ? { ok: true, ref: id } : { ok: false, detail: "no live cloud stream for this printer" };
  }
}
