// The edge-bridge protocol, written once.
//
// The bridge serves a fixed surface per configured instance:
//   GET  /<instance>/devices                      → [ { id, name, state } ]
//   POST /<instance>/upload   (file)              → { fileId }
//   POST /<instance>/submit   { fileId, target? } → { jobId, queued? }
//   GET  /<instance>/status/<jobId>               → { state, detail? }
//
// Two very different callers need to speak it: core-print's server-side driver
// (through the cloud→edge tunnel) and the web app (a direct fetch to a bridge on
// the user's own machine). An earlier attempt gave each its own implementation,
// which meant the protocol lived in three places and they drifted — one of them
// shipped speaking paths nothing served. So the sequencing lives HERE, in the
// contract package both already import (the label-geometry precedent), and each
// caller supplies only a transport.
//
// The transport is the only thing that differs:
//   • the tunnel cannot carry multipart, so a file rides base64 in JSON
//     (core-print adapts its EdgeRelay to this shape);
//   • a direct fetch uses real multipart (httpBridgeTransport below).
//
// Deliberately NOT here: any server-side fetch of a user-controlled bridge URL.
// httpBridgeTransport exists for the BROWSER, where "private address" means the
// user's own machine. Server code adapts its relay instead and never dials.

/** True for a manager URL that routes through an on-site edge bridge rather than
 *  a direct address. The scheme IS the routing decision, so this predicate lives
 *  beside the protocol rather than inside any one module: core-print builds a
 *  driver from it, and the UI needs it to say "via edge bridge" instead of
 *  "Network" — a module boundary should not force a second copy of one regex. */
export function isEdgeManagerUrl(baseUrl: string | null | undefined): boolean {
  return /^cobblr-edge:/i.test(baseUrl ?? "");
}

/** The instance segment of a `cobblr-edge://<instance>` manager URL, or null.
 *
 *  Beside the predicate for the same reason: this pattern had four copies, in
 *  core-print, digifab twice, and the print page. They agree today; nothing made
 *  them agree, and they decide which machine on someone's LAN a job is sent to. */
export function edgeInstanceOf(baseUrl: string | null | undefined): string | null {
  const raw = (/^cobblr-edge:\/\/(.*)$/i.exec(baseUrl ?? "")?.[1] ?? "").replace(/^\/+|\/+$/g, "");
  return raw || null;
}

export interface BridgeDeviceInfo {
  id?: string;
  name?: string;
  state?: string;
  /** The device's media calibration, when the bridge reports one — head width,
   *  label geometry, dialect. Open-ended on purpose: the bridge sends what it
   *  has, and a consumer reads the keys it cares about. Narrowing this to the
   *  one field a caller needed today is what made every later need a two-sided
   *  release. */
  media?: {
    widthDots?: number;
    widthMm?: number;
    dpi?: number;
    labelHeightMm?: number;
    gapMm?: number;
    protocol?: string;
  };
}

export interface BridgeTransportRequest {
  method: "GET" | "POST";
  /** Instance-prefixed path, e.g. `/labels/upload`. */
  path: string;
  body?: unknown;
  file?: { bytes: Uint8Array; filename: string };
  /** Per-request deadline. A metadata call answers in milliseconds; anything
   *  that DRIVES the hardware can take far longer — a sleeping Bluetooth printer
   *  with retries is tens of seconds — and one global timeout cannot serve both. */
  timeoutMs?: number;
}

export type BridgeTransport = (r: BridgeTransportRequest) => Promise<{ status: number; body: unknown }>;

export interface BridgePrinterSettings {
  /** Where the bridge listens when it is on the user's own machine
   *  (e.g. http://127.0.0.1:8077). Set → the BROWSER prints to it directly. */
  bridgeUrl?: string;
  /** The instance id in the bridge's config — it serves each at /<id>/. */
  instance?: string;
  /** Per-instance shared secret, if the bridge config set one. */
  token?: string;
  /** NAMED bridge for the tunnel channel (orgId::<name>); unset → the
   *  workspace's default bridge. Matches digifab's config.bridge. */
  bridgeName?: string;
  /** Raster width for labels drawn in the browser. Must not exceed the width
   *  the bridge instance is calibrated for — its thermal driver refuses a PNG
   *  wider than the device rather than silently scaling. */
  widthDots?: number;
  labelHeightMm?: number;
}

export class BridgeRequestError extends Error {
  // NOT a parameter property: the built api consumes this package under node's
  // type stripping, which refuses non-erasable syntax like `readonly` params.
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A direct-fetch transport, for the browser.
 *
 *  Turns the browser's opaque network failure into something a person can act
 *  on: a blocked-by-CORS fetch and a bridge that is not running both reject
 *  with a bare "Failed to fetch" and no status, and they have completely
 *  different fixes. */
export function httpBridgeTransport(
  baseUrl: string,
  opts: { token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): BridgeTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return async (r) => {
    const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
    let body: FormData | string | undefined;
    if (r.file) {
      // Real multipart, and no content-type header: only the fetch layer knows
      // the boundary, and setting it by hand produces an unparseable body.
      const form = new FormData();
      const parts = [r.file.bytes] as unknown as ConstructorParameters<typeof Blob>[0];
      form.append("file", new Blob(parts), r.file.filename);
      body = form;
    } else if (r.body !== undefined) {
      body = JSON.stringify(r.body);
      headers["content-type"] = "application/json";
    }
    const deadline = r.timeoutMs ?? opts.timeoutMs ?? 20_000;
    let res: Response;
    try {
      res = await doFetch(base + r.path, { method: r.method, headers, body, signal: AbortSignal.timeout(deadline) });
    } catch (e) {
      // A TIMEOUT is not a connection failure, and conflating them sends people
      // to the wrong fix. Measured: a status read on a sleeping printer blew the
      // 20s default and reported "is the bridge running?" while the bridge was
      // answering other calls in 22ms.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new BridgeRequestError(
          `the bridge did not answer ${r.method} ${r.path} within ${Math.round(deadline / 1000)}s. ` +
            "It is running — this is the printer taking too long, usually because it is asleep or out of range.",
          0,
        );
      }
      throw new BridgeRequestError(
        `could not reach the bridge at ${base}. Is it running? If it is, this page's origin ` +
          "may not be in the bridge's allowedOrigins, or the browser blocked the private-network request.",
        0,
      );
    }
    const parsed = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  };
}

function errText(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) return JSON.stringify((body as { error: unknown }).error);
  return String(status);
}

export class EdgeBridgeClient {
  private readonly prefix: string;
  private readonly transport: BridgeTransport;

  constructor(transport: BridgeTransport, instance?: string) {
    this.transport = transport;
    const id = (instance ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = id ? `/${id}` : "";
  }

  private async req(method: "GET" | "POST", path: string, opts: Omit<BridgeTransportRequest, "method" | "path"> = {}): Promise<unknown> {
    const full = this.prefix + path;
    const r = await this.transport({ method, path: full, ...opts });
    if (r.status >= 400) throw new BridgeRequestError(`bridge ${method} ${full} → ${errText(r.body, r.status)}`, r.status);
    return r.body ?? null;
  }

  async devices(): Promise<BridgeDeviceInfo[]> {
    const d = await this.req("GET", "/devices");
    return Array.isArray(d) ? (d as BridgeDeviceInfo[]) : [];
  }

  async upload(bytes: Uint8Array, filename: string): Promise<string> {
    const d = (await this.req("POST", "/upload", { file: { bytes, filename } })) as { fileId?: string } | null;
    if (!d?.fileId) throw new Error("bridge accepted the upload but returned no fileId");
    return d.fileId;
  }

  async submit(fileId: string, target?: string): Promise<{ jobId: string; state?: string }> {
    const d = (await this.req("POST", "/submit", { body: { fileId, ...(target ? { target } : {}) } })) as {
      jobId?: unknown;
      state?: unknown;
    } | null;
    if (d?.jobId == null) throw new Error("bridge accepted the job but returned no job id");
    return { jobId: String(d.jobId), ...(d.state != null ? { state: String(d.state) } : {}) };
  }

  /** Run a driver command on the instance — e.g. `status`, which is how a
   *  thermal printer reports its loaded roll and battery.
   *
   *  Not every driver implements commands (the bridge answers 501), and that is
   *  a normal answer rather than a fault: a printer that cannot self-report is
   *  still a working printer. Callers get ok:false with the reason and decide. */
  async command(
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; detail?: string; data?: Record<string, unknown> }> {
    try {
      const d = (await this.req("POST", "/command", {
        body: { command: name, params },
        // Drives the hardware: a Bluetooth printer that has gone to sleep needs
        // waking, and the bridge retries the open before giving up.
        timeoutMs: 90_000,
      })) as { ok?: boolean; detail?: string; data?: Record<string, unknown> } | null;
      // `data` carries the reading for commands that READ rather than act
      // (thermal's status: the loaded roll and battery, as numbers). An older
      // bridge sends only the prose `detail`, so nothing may require it.
      return {
        ok: d?.ok !== false,
        ...(d?.detail ? { detail: d.detail } : {}),
        ...(d?.data && typeof d.data === "object" ? { data: d.data } : {}),
      };
    } catch (e) {
      const status = e instanceof BridgeRequestError ? e.status : 0;
      if (status === 501) return { ok: false, detail: "this printer cannot report its status" };
      throw e;
    }
  }

  async status(jobId: string): Promise<{ state?: string; detail?: string }> {
    const d = (await this.req("GET", `/status/${encodeURIComponent(jobId)}`)) as { state?: string; detail?: string } | null;
    return d ?? {};
  }

  /** Upload one document and submit it — the whole print, in protocol order. */
  async printOnce(bytes: Uint8Array, filename: string, target?: string): Promise<{ jobId: string; state?: string }> {
    return this.submit(await this.upload(bytes, filename), target);
  }

  /** Poll until the job leaves the queue, bounded.
   *
   *  A timeout is NOT reported as failure — the label may well be mid-print, and
   *  claiming failure over paper that physically came out is worse than saying
   *  we stopped watching. Only a `failed` state from the bridge throws. */
  async waitForJob(jobId: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "queued";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        const st = await this.status(jobId);
        last = st.state ?? last;
        if (last === "completed") return last;
        if (last === "failed") throw new Error(`the printer rejected the job: ${st.detail ?? "no detail"}`);
      } catch (e) {
        // A failed status POLL is not a failed print; keep watching the window.
        if (e instanceof Error && e.message.startsWith("the printer rejected")) throw e;
      }
    }
    return last;
  }
}
