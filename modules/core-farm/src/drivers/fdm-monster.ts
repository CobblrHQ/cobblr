// FDM Monster driver (v2 API). Confirmed against a live FDM Monster v2:
// auth is login (username+password → JWT) or x-api-key; the collection is
// /api/v2/printer/; routing (the author's PR) lives at /api/v2/routing/. Upload +
// place a file, then poll /api/v2/print-jobs.
//
// Read-only calls (testConnection, listPrinters, resolvePlacement) are
// verified live. submitJob / getJobStatus are wired to the v2 routing +
// print-jobs endpoints and confirmed when a real send is authorized
// (the bits still worth re-checking with a real job are marked VERIFY).

import type {
  ConnectionResult,
  FarmConnectionConfig,
  FarmDriver,
  JobState,
  JobStatus,
  PlacementResolution,
  RemotePrinter,
  SubmitArgs,
  SubmitResult,
  UploadResult,
} from "./types.js";

const EP = {
  login: "/api/v2/auth/login",
  printers: "/api/v2/printer/",
  printer: (id: string) => `/api/v2/printer/${id}`,
  upload: "/api/v2/file-storage/upload",
  printJob: (id: string) => `/api/v2/print-jobs/${id}`,
  routingResolve: (fileId: string) => `/api/v2/routing/resolve/${fileId}`,
  routingQueue: (fileId: string) => `/api/v2/routing/queue/${fileId}`,
  queueFromFile: (printerId: string) => `/api/v2/print-queue/${printerId}/from-file`,
  spec: "/api-docs/swagger.json",
};

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

function toJobState(raw: unknown): JobState {
  const s = String(pick(raw, "status", "state", "jobState") ?? "").toLowerCase();
  if (/print|running|operational|started/.test(s)) return "printing";
  if (/done|complete|success|finished/.test(s)) return "completed";
  if (/cancel|abort/.test(s)) return "cancelled";
  if (/fail|error/.test(s)) return "failed";
  if (/pause/.test(s)) return "paused";
  if (/pending|queue|scheduled|unknown/.test(s)) return "queued";
  return s ? "unknown" : "queued";
}

export class FdmMonsterDriver implements FarmDriver {
  private base: string;
  private cfg: FarmConnectionConfig;
  private token: string | null = null;
  private routing: boolean | null = null;
  // Discovered from the spec at probe time — the routing endpoints have
  // been named both /routing/ and /print-file-routing/ across PR revisions.
  private routingResolvePath: ((id: string) => string) | null = null;
  private routingQueuePath: ((id: string) => string) | null = null;

  constructor(cfg: FarmConnectionConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.cfg = cfg;
  }

  private async login(): Promise<void> {
    if (!this.cfg.username || !this.cfg.password) return;
    const res = await fetch(this.base + EP.login, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }),
    });
    if (!res.ok) throw new Error(`login → ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = (await res.json()) as Record<string, unknown>;
    this.token = String(pick(body, "token", "access_token", "accessToken") ?? "");
    if (!this.token) throw new Error("login succeeded but returned no token");
  }

  private authHeaders(): Record<string, string> {
    // FDM Monster v2 is Bearer auth for both the login JWT and an
    // `fdmm_api_*` API key — the key goes in Authorization: Bearer too
    // (NOT x-api-key, which is a separate legacy server header).
    const bearer = this.token ?? this.cfg.apiKey;
    return bearer ? { Authorization: `Bearer ${bearer}` } : {};
  }

  /** Authed fetch with one re-login retry on 401. */
  private async req(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.token && this.cfg.username && this.cfg.password) await this.login();
    const res = await fetch(this.base + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...this.authHeaders() },
    });
    if (res.status === 401 && retry && this.cfg.username && this.cfg.password) {
      this.token = null;
      await this.login();
      return this.req(path, init, false);
    }
    return res;
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.req(path, init);
    if (!res.ok) {
      throw new Error(`FDM Monster ${init?.method ?? "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.json(EP.printers);
      return { ok: true, capabilities: { routing: await this.probeRouting() } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, capabilities: { routing: false } };
    }
  }

  /** Routing capability = the v2 routing endpoints exist in the OpenAPI
   *  spec (the spec is unauthenticated). More reliable than poking a
   *  resolve route, which 404s for an unknown file either way. */
  private async probeRouting(): Promise<boolean> {
    if (this.routing !== null) return this.routing;
    try {
      const res = await fetch(this.base + EP.spec);
      const spec = (await res.json()) as { paths?: Record<string, unknown> };
      const paths = Object.keys(spec.paths ?? {});
      // Matches both /api/v2/routing/resolve/{id} and
      // /api/v2/print-file-routing/resolve/{id}.
      const resolveP = paths.find((p) => /routing\/resolve\//.test(p));
      const queueP = paths.find((p) => /routing\/queue\//.test(p));
      if (resolveP && queueP) {
        const rBase = resolveP.replace(/\{[^}]+\}.*$/, "");
        const qBase = queueP.replace(/\{[^}]+\}.*$/, "");
        this.routingResolvePath = (id) => rBase + id;
        this.routingQueuePath = (id) => qBase + id;
        this.routing = true;
      } else {
        this.routing = false;
      }
    } catch {
      this.routing = false;
    }
    return this.routing;
  }

  async listPrinters(): Promise<RemotePrinter[]> {
    const data = await this.json(EP.printers);
    const arr = Array.isArray(data) ? data : (pick<unknown[]>(data, "printers", "items") ?? []);
    return (arr as unknown[]).map((p) => ({
      id: String(pick(p, "id", "_id") ?? ""),
      name: String(pick(p, "name", "printerName") ?? "unnamed"),
      enabled: Boolean(pick(p, "enabled") ?? true),
      state: (pick<string>(p, "printerState", "state") ?? null) as string | null,
      tags: (pick<string[]>(p, "tags") ?? []) as string[],
    }));
  }

  async setPrinterEnabled(printerId: string, enabled: boolean): Promise<void> {
    // VERIFY against a real toggle. FDM Monster v2 also has a
    // /api/v2/batch/toggle-enabled; the per-printer PATCH is the simplest.
    await this.json(EP.printer(printerId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  }

  async uploadFile(file: Uint8Array, filename: string): Promise<UploadResult> {
    const form = new FormData();
    form.append("files", new Blob([file]), filename); // VERIFY field name ("files"/"file")
    const data = await this.json(EP.upload, { method: "POST", body: form });
    const fileId = String(pick(data, "fileStorageId", "id", "_id", "storageId") ?? filename);
    return { fileId, filename };
  }

  async resolvePlacement(fileId: string): Promise<PlacementResolution> {
    if (!(await this.probeRouting()) || !this.routingResolvePath) return { kind: "none", matchedName: null, printerIds: [] };
    const data = await this.json(this.routingResolvePath(fileId));
    return {
      kind: (pick<string>(data, "kind") ?? "none") as PlacementResolution["kind"],
      matchedName: (pick<string>(data, "matchedName") ?? null) as string | null,
      printerIds: ((pick<unknown[]>(data, "printerIds") ?? []) as unknown[]).map(String),
    };
  }

  async submitJob(args: SubmitArgs): Promise<SubmitResult> {
    // Routed path (the author's PR): hand the file to FDM Monster routing.
    if ((await this.probeRouting()) && this.routingQueuePath && !args.printerId) {
      const data = await this.json(this.routingQueuePath(args.fileId), { method: "POST" });
      const printerId = pick<unknown>(data, "printerId");
      const queued = Boolean(pick(data, "queued") ?? printerId != null);
      return {
        jobId: (pick<string>(data, "jobId", "id") ?? null) as string | null,
        printerId: printerId != null ? String(printerId) : null,
        queued,
        status: queued ? "queued" : "awaiting-assignment",
      };
    }
    // Explicit printer → v2 print-queue from-file. VERIFY body + response.
    const data = await this.json(EP.queueFromFile(String(args.printerId)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileStorageId: args.fileId }),
    });
    return {
      jobId: String(pick(data, "id", "jobId", "_id") ?? ""),
      printerId: args.printerId ?? null,
      queued: true,
      status: "queued",
    };
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const data = await this.json(EP.printJob(jobId));
    const prog = pick<number>(data, "progress", "completion");
    return {
      jobId,
      state: toJobState(data),
      progress: prog != null ? (prog > 1 ? prog / 100 : prog) : null,
      printerId: (pick<string>(data, "printerId") ?? null) as string | null,
      raw: data,
    };
  }
}

export const fdmMonsterFactory = (cfg: FarmConnectionConfig) => new FdmMonsterDriver(cfg);
