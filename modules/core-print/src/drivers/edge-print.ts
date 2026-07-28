// Edge-print driver — the transport for a print manager that lives on the user's
// LAN, reached from a HOSTED Cobblr through the on-site edge bridge. A hosted
// instance can't (and mustn't) dial a private IP directly (see ssrf.ts). So when
// a printer's manager URL is `cobblr-edge://<instance>`, we don't speak to it
// from the cloud — we hand the whole job to the bridge over the dial-out relay.
// Pure coordinate-not-control: Cobblr only ever talks to its own relay; the
// bridge reaches the device.
//
// The PROTOCOL (devices/upload/submit/status — the surface the bridge actually
// serves) lives in @cobblr/platform-contract/edge-bridge-client, written once
// and shared with the browser path. This file only adapts core-print's relay to
// the client's transport shape. It previously carried its own protocol speaking
// `/print/test` + `/print/job`, which NOTHING implements — the bridge has no
// CUPS driver, those paths were written for one, and the only coverage was a
// mock relay that agreed with whatever it was asked.
//
// This driver NEVER fetches. A bridge on the user's own machine (settings.bridge
// with a bridgeUrl) is printed to by the BROWSER — see platform-web's
// print-directive — because from the server that address is loopback on someone
// else's computer, and a server-side fetch of a user-controlled URL is exactly
// what the SSRF guard exists to prevent.
//
// Identifier convention (matches digifab): `cobblr-edge://<id>` names the
// INSTANCE on the bridge. WHICH bridge (the tunnel channel) is settings.bridge
// .bridgeName, unset meaning the workspace's default bridge — see edge.ts.

import { EdgeBridgeClient, type BridgeTransport } from "@cobblr/platform-contract/edge-bridge-client";
import type { PrintDriver, PrintDoc, PrintJobResult, PrinterConfig } from "./types.js";

/** A relay transport — routes a bridge call through the cloud→edge tunnel
 *  (platform().edge) instead of dialing an address. Supplied by the caller
 *  (which holds the org id + channel key), so this driver is platform-free.
 *  Shape matches digifab's EdgeRelay deliberately. */
export type EdgeRelay = (req: { method: "GET" | "POST"; path: string; body?: unknown }) => Promise<{
  status: number;
  body: unknown;
}>;

const JOB_STATES = new Set<PrintJobResult["state"]>(["pending", "processing", "completed", "stopped", "unknown"]);

function coerceState(raw: unknown): PrintJobResult["state"] {
  const s = String(raw ?? "").toLowerCase();
  if (JOB_STATES.has(s as PrintJobResult["state"])) return s as PrintJobResult["state"];
  if (/done|complete|finish|success/.test(s)) return "completed";
  if (/stop|cancel|abort|fail|error/.test(s)) return "stopped";
  if (/print|process|run|start/.test(s)) return "processing";
  // A freshly accepted job the bridge didn't classify is pending (mirrors the
  // direct CUPS path, where Print-Job carries no job-state).
  return "pending";
}

/** The tunnel cannot carry multipart, so a file rides base64 in JSON — the same
 *  shape digifab's edge-adapter sends and the bridge's tunnel end decodes. */
function relayTransport(relay: EdgeRelay): BridgeTransport {
  return async (r) => {
    const body = r.file ? { filename: r.file.filename, data_b64: Buffer.from(r.file.bytes).toString("base64") } : r.body;
    return relay({ method: r.method, path: r.path, body });
  };
}

/** The instance segment of a `cobblr-edge://<instance>` manager URL. */
import { edgeInstanceOf } from "@cobblr/platform-contract/edge-bridge-client";
export { edgeInstanceOf };

export class EdgePrintDriver implements PrintDriver {
  private readonly client: EdgeBridgeClient | null;

  constructor(cfg: PrinterConfig, relay: EdgeRelay | null) {
    this.cfg = cfg;
    const instance = cfg.bridge?.instance || edgeInstanceOf(cfg.baseUrl ?? "") || undefined;
    this.client = relay ? new EdgeBridgeClient(relayTransport(relay), instance) : null;
  }

  private cfg: PrinterConfig;

  private need(): EdgeBridgeClient {
    if (!this.client) {
      // A cobblr-edge:// manager with no live relay = no bridge is connected for
      // this workspace right now. Fail honestly rather than pretend-succeed.
      // (A local bridge — settings.bridge.bridgeUrl — is the BROWSER's job, and
      // the UI says so; the server cannot reach someone else's loopback.)
      throw new Error("no edge bridge is connected for this workspace — start the bridge and try again");
    }
    return this.client;
  }

  /** Ask the bridge what it has. Reaching the printer itself is the print's job;
   *  this proves the bridge answers and the instance exists — two different
   *  failures with two different fixes, so they are reported apart. */
  async test(): Promise<{ ok: boolean; error?: string; detail?: string }> {
    try {
      const client = this.need();
      const devices = await client.devices();
      if (devices.length === 0) {
        return { ok: false, error: "the bridge answered but has no device on this instance — check the instance id" };
      }
      // Reachable is not the same as ready. Ask the printer what it reports about
      // itself (roll + battery on a thermal one) so the answer is useful rather
      // than merely green. A driver with no commands answers 501, which is not a
      // failure — the connection is still good.
      const status = await client.command("status").catch(() => ({ ok: false, detail: undefined }));
      return { ok: true, ...(status.detail ? { detail: status.detail } : {}) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async print(doc: PrintDoc, opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult> {
    const client = this.need();
    const copies = Math.max(1, opts?.copies ?? 1);
    // One upload, N submits: the contract takes one file per job and no copy
    // count, so copies are repeat submissions of the same fileId.
    const fileId = await client.upload(doc.bytes, doc.filename);
    let last: { jobId: string; state?: string } | null = null;
    for (let i = 0; i < copies; i++) {
      last = await client.submit(fileId, this.cfg.queue || undefined);
    }
    return { jobId: last!.jobId, state: coerceState(last!.state) };
  }
}
