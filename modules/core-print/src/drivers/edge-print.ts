// Edge-print driver — the transport for a print manager that lives on the user's
// LAN, reached from a HOSTED Cobblr through the on-site edge bridge. A hosted
// instance can't (and mustn't) dial a private IP directly (see ssrf.ts). So when
// a printer's manager URL is `cobblr-edge://<bridge-id>`, we don't speak IPP to
// it from the cloud — we hand the whole print job to the bridge over the dial-out
// relay, and the bridge speaks IPP to CUPS locally. Pure coordinate-not-control:
// Cobblr only ever talks to its own relay; the bridge reaches the device.
//
// This MIRRORS digifab's edge-adapter (modules/digifab/src/drivers/edge-adapter.ts):
// a fixed webhook-shaped contract the bridge serves, and a `relay` closure the
// caller supplies (which holds platform().edge + the org's channel key), so this
// driver stays platform-free and testable. The relay is null for a direct
// `http(s)://` manager (that path uses CupsDriver instead, chosen in registry.ts).
//
// Contract the bridge serves for core-print (JSON both ways — the relay carries
// JSON, so the document rides base64-encoded, exactly like edge-adapter's upload):
//   POST {prefix}/print/test  { queue }                         → { ok, error? }
//   POST {prefix}/print/job   { queue, filename, contentType,
//                               data_b64, copies?, jobName?, username? } → { jobId, state? }

import type { PrintDriver, PrintDoc, PrintJobResult, PrinterConfig } from "./types.js";

/** A relay transport — routes a core-print bridge call through the cloud→edge
 *  tunnel (platform().edge) instead of dialing an address directly. Supplied by
 *  the caller (which holds the org id + channel key), so this driver is
 *  platform-free. Shape matches digifab's EdgeRelay deliberately. Returns the
 *  bridge's { status, body }. */
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

export class EdgePrintDriver implements PrintDriver {
  /** Optional instance segment parsed from `cobblr-edge://<id>`. For core-print
   *  the id names the BRIDGE, which the relay closure already targets via its
   *  channel key — so the path carries NO prefix (unlike digifab, where one bridge
   *  fronts many machine instances). Kept for parity / forward-compat only. */
  constructor(
    private cfg: PrinterConfig,
    private relay: EdgeRelay | null,
  ) {}

  private async req(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    if (!this.relay) {
      // A cobblr-edge:// manager with no live relay = no bridge is connected for
      // this workspace right now. Fail honestly rather than pretend-succeed.
      throw new Error("no edge bridge is connected for this workspace — start the bridge and try again");
    }
    const r = await this.relay({ method, path, body });
    if (r.status >= 400) {
      const detail =
        r.body && typeof r.body === "object" && "error" in r.body
          ? JSON.stringify((r.body as { error: unknown }).error)
          : String(r.status);
      throw new Error(`edge print ${method} ${path} → ${detail}`);
    }
    return r.body ?? null;
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = (await this.req("POST", "/print/test", { queue: this.cfg.queue })) as { ok?: boolean; error?: string };
      return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "printer not reachable through the bridge" };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async print(doc: PrintDoc, opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult> {
    const r = (await this.req("POST", "/print/job", {
      queue: this.cfg.queue,
      filename: doc.filename,
      contentType: doc.contentType || "application/octet-stream",
      data_b64: Buffer.from(doc.bytes).toString("base64"),
      ...(opts?.copies && opts.copies > 1 ? { copies: opts.copies } : {}),
      jobName: opts?.jobName ?? doc.filename,
      ...(this.cfg.username ? { username: this.cfg.username } : {}),
    })) as { jobId?: unknown; state?: unknown } | null;
    const jobId = r?.jobId != null ? String(r.jobId) : null;
    if (!jobId) throw new Error("bridge accepted the job but returned no job id");
    return { jobId, state: coerceState(r?.state) };
  }
}
