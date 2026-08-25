// Per-(workspace, module) wasm worker pool.
//
// Workers spin up on demand (first request that needs them) and
// stick around until they idle out (5 min default). On deadline
// exceed (a wasm tight loop) the worker is terminated; the next
// invocation spawns a fresh one.
//
// Invocations are serialised per worker: if request B comes in
// while A is still running in the same worker, B waits in a
// FIFO queue. Per-worker concurrency = 1 keeps the wasm import
// state (`currentId`, `currentLogs`) simple — only one in-flight
// at a time. Cross-worker concurrency is unbounded (different
// (workspace, module) pairs run in parallel).
//
// Termination policy (v0.3):
//   - deadlineMs (default 1000) → worker.terminate() if exceeded.
//   - Idle eviction: WORKER_IDLE_EVICT_MS (default 5 min).
//   - Hard pool cap: WORKER_POOL_MAX (default 64). Beyond cap,
//     least-recently-used worker is evicted to make room.

import { Worker } from "node:worker_threads";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantPool } from "../db/tenant.js";
import {
  commaListTables,
  containsMultipleStatements,
  forbiddenReadConstruct,
  unquoteIdent,
  usingTables,
} from "./sql-guards.js";
import { validateFetchTarget } from "./ssrf.js";
import { isModuleRoleReady, moduleRoleName } from "./module-role.js";
// The redirect-following, IP-pinning loop is shared with the kernel egress and
// scan image fetches; HOST_FETCH supplies the sandbox policy (validateFetchTarget)
// and reads/caps the body itself.
import { pinnedRedirectingFetch, type PinnedFetchResult } from "@cobblr/platform-net";
import { platform } from "@cobblr/platform-contract";
import {
  OP,
  SAB_DATA_OFFSET_BYTES,
  SAB_LENGTH_OFFSET,
  SAB_MAX_PAYLOAD_BYTES,
  SAB_SIGNAL_OFFSET,
  SAB_STATUS_ERROR,
  SAB_STATUS_READY,
  SAB_STATUS_TOO_BIG,
  SAB_TOTAL_BYTES,
} from "./abi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The worker entry URL.
 *
 *  Built prod: `worker-entry.js` sits next to the compiled `pool.js`.
 *
 *  Dev/test (api runs from source via tsx): only `worker-entry.ts`
 *  exists, AND tsx does not do `.js`→`.ts` resolution inside worker
 *  threads (its loader patches the main thread only) — so a worker that
 *  imports `./abi.js` 500s with "Cannot find module". We sidestep that
 *  by bundling the worker subtree into a standalone, dependency-inlined
 *  `.mjs` with esbuild (which ships with tsx) and pointing the Worker at
 *  THAT. Bundled once per process, cached. esbuild is loaded via dynamic
 *  import so prod (which never takes this branch) never needs it. */
let workerEntryPromise: Promise<URL> | null = null;
function workerEntryUrl(): Promise<URL> {
  if (!workerEntryPromise) workerEntryPromise = resolveWorkerEntry();
  return workerEntryPromise;
}
async function resolveWorkerEntry(): Promise<URL> {
  if (!import.meta.url.endsWith(".ts")) {
    return pathToFileURL(resolve(__dirname, "worker-entry.js"));
  }
  // Local tsx dev: the worker thread can't load .ts (no .js→.ts resolution in
  // worker threads), so esbuild-bundle worker-entry to a temp .mjs. NOTE: this
  // bundle path is dev-on-macOS only — it miscompiles on Linux, and CI runs
  // the api built (`node dist`) precisely to avoid it (see .forgejo/ci.yml).
  const { build } = await import("esbuild");
  const out = join(tmpdir(), `cobblr-worker-entry-${process.pid}.mjs`);
  await build({
    entryPoints: [resolve(__dirname, "worker-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "silent",
  });
  return pathToFileURL(out);
}

const WORKER_IDLE_EVICT_MS = Number(process.env.SANDBOX_WORKER_IDLE_MS ?? 5 * 60 * 1000);
const WORKER_POOL_MAX = Number(process.env.SANDBOX_WORKER_POOL_MAX ?? 64);
const DEFAULT_DEADLINE_MS = Number(process.env.SANDBOX_DEFAULT_DEADLINE_MS ?? 1000);

/** Max simultaneous in-flight invocations for ONE workspace, summed
 *  across all its modules. Without this a single workspace could fan
 *  out across many modules, pass the up-front CPU gate concurrently
 *  (TOCTOU — none have recorded time yet), and occupy a large slice of
 *  the global worker pool. Excess invocations are rejected up-front with
 *  429 instead of queueing unbounded. (Audit 2026-06-19 finding #5.) */
const MAX_CONCURRENCY_PER_WS = Number(process.env.SANDBOX_MAX_CONCURRENCY_PER_WS ?? 4);

/** Live count of in-flight invocations per workspace. */
const inflightByOrg = new Map<string, number>();

/** Thrown by spawnWorker when the global pool is full and every worker
 *  is busy (so none can be LRU-evicted). Surfaced to the caller as a
 *  503 rather than letting the pool grow without bound. */
class PoolExhaustedError extends Error {}

/** CPU accounting + quota. The pool tracks per-workspace wasm
 *  invocation time (wall-clock — since the worker is single-
 *  threaded busy work, wall ≈ CPU). On each invocation, the elapsed
 *  ms get appended to a per-workspace ring of samples; samples
 *  older than CPU_WINDOW_MS are pruned on read.
 *
 *  Before a new invocation starts, the pool sums the workspace's
 *  recent samples; if they exceed CPU_QUOTA_MS_PER_WINDOW, the call
 *  is rejected with `cpu_quota_exceeded` (HTTP 429). The quota
 *  is wall-clock — wasmtime epoch interrupts would be more precise
 *  (the host would yield mid-instruction) but Node's WebAssembly
 *  doesn't expose them; for cobblr's use case the wall-clock proxy
 *  is sufficient + much simpler to operate.
 *
 *  Default: 60s window, 30s of CPU budget. Tunable via env. */
const CPU_WINDOW_MS = Number(process.env.SANDBOX_CPU_WINDOW_MS ?? 60_000);
const CPU_QUOTA_MS_PER_WINDOW = Number(
  process.env.SANDBOX_CPU_QUOTA_MS_PER_WINDOW ?? 30_000,
);

export interface InvocationContext {
  orgId: string;
  userId: string;
  moduleName: string;
  wasmPath: string;
  maxMemoryPages: number;
  /** Override per-invocation deadline. */
  deadlineMs?: number;
  /** Network egress allowlist from the manifest. Empty = no fetch
   *  access (the HOST_FETCH op short-circuits). Each entry is a
   *  host (e.g. "api.bricklink.com"); the host enforces match
   *  against the URL's hostname. */
  network?: string[];
  /** Module's table prefix for TENANT_QUERY validation. Defaults
   *  to <moduleName_underscored>_. */
  tablePrefix?: string;
  /** Allowed cross-module read tables (full names, e.g.
   *  "inventory_parts"). TENANT_QUERY allows SELECTs that reference
   *  these in addition to the module's own prefix. TENANT_EXEC
   *  never honors this — writes always require own-prefix. */
  allowedReadTables?: Set<string>;
  /** The inbound HTTP request, captured by the loader. Surfaced
   *  to the wasm via the HOST_GET_REQUEST_BODY op. */
  request?: {
    body: unknown;
    query: Record<string, string>;
    route: string;
  };
  /** Aborted when the invocation's deadline fires or the worker
   *  dies. Read by runHostFetch so an in-flight outbound HTTP
   *  call doesn't outlive the wasm that started it. Attached per-
   *  invocation in runInvocation. */
  abortSignal?: AbortSignal;
}

export interface InvocationResult {
  ok: boolean;
  logs: Array<{ level: number; message: string }>;
  kernelCalls: number;
  error?: string;
  /** True when the worker was killed for exceeding deadline. */
  terminated?: boolean;
  /** Set when the wasm called HOST_RESPOND. The route handler
   *  emits this verbatim as the HTTP response instead of the
   *  default { ok, logs, kernel_calls } envelope. */
  responseBody?: string;
  responseStatus?: number;
  /** Wall-clock ms the invocation occupied — counted against the
   *  workspace's CPU quota. */
  cpuMs?: number;
  /** Set when the call was rejected up-front for CPU-quota
   *  reasons (no worker spawned, no wasm run). */
  cpuQuotaExceeded?: boolean;
  /** Set when the workspace already has MAX_CONCURRENCY_PER_WS
   *  invocations in flight. Maps to HTTP 429. */
  concurrencyExceeded?: boolean;
  /** Set when the global worker pool is full and no worker is free to
   *  evict. Maps to HTTP 503. */
  poolExhausted?: boolean;
}

interface PooledWorker {
  worker: Worker;
  key: string;
  orgId: string;
  moduleName: string;
  wasmPath: string;
  /** Shared with the worker — read-bearing ops pass their result
   *  through this region while the worker blocks on Atomics.wait. */
  sab: SharedArrayBuffer;
  sigView: Int32Array;
  /** When the current invocation (if any) started; null if idle. */
  invocationStartedAt: number | null;
  /** Last completed invocation timestamp; for LRU. */
  lastUsedAt: number;
  /** Resolves when the worker has posted its "ready" message. */
  readyPromise: Promise<void>;
  /** Serialises invocations into this worker. Each invocation
   *  chains its work onto the previous one. */
  invocationChain: Promise<unknown>;
}

/** Op codes that return data via the SAB (read-bearing). Used by
 *  both the host (to know to write to SAB) and the worker (to know
 *  to block on Atomics.wait instead of fire-and-forget). */
const READ_BEARING_OPS = [
  OP.TENANT_QUERY,
  OP.TENANT_EXEC,
  OP.PAIRINGS_FIND_BY_TARGETS,
  OP.CATALOGS_QUERY_ENTRIES,
  OP.HOST_FETCH,
  OP.HOST_GET_REQUEST_BODY,
] as const;

const pool = new Map<string, PooledWorker>();
let evictTimer: NodeJS.Timeout | null = null;

function ensureEvictTimer() {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, p] of pool.entries()) {
      // Don't evict while an invocation is in flight.
      if (p.invocationStartedAt !== null) continue;
      if (now - p.lastUsedAt > WORKER_IDLE_EVICT_MS) {
        retire(key, "idle");
      }
    }
  }, Math.min(WORKER_IDLE_EVICT_MS / 2, 60_000));
  // Don't keep the process alive just for the evict timer.
  evictTimer.unref();
}

function poolKey(orgId: string, moduleName: string): string {
  return `${orgId}::${moduleName}`;
}

function retire(key: string, reason: "idle" | "deadline" | "pool-cap" | "error"): void {
  const p = pool.get(key);
  if (!p) return;
  pool.delete(key);
  p.worker.terminate().catch(() => {});
  console.log(`[sandbox-pool] retired ${key} (${reason})`);
}

async function spawnWorker(
  orgId: string,
  moduleName: string,
  wasmPath: string,
  maxMemoryPages: number,
): Promise<PooledWorker> {
  // Pool-cap eviction (LRU). Only IDLE workers can be evicted — killing
  // a busy one would abort another workspace's in-flight invocation.
  if (pool.size >= WORKER_POOL_MAX) {
    let oldest: { key: string; lastUsedAt: number } | null = null;
    for (const [key, p] of pool.entries()) {
      if (p.invocationStartedAt !== null) continue;
      if (!oldest || p.lastUsedAt < oldest.lastUsedAt) {
        oldest = { key, lastUsedAt: p.lastUsedAt };
      }
    }
    if (oldest) retire(oldest.key, "pool-cap");
  }
  // If still at capacity, every slot is busy — refuse rather than grow
  // the pool (and its memory) without bound. (Audit 2026-06-19 #5.)
  if (pool.size >= WORKER_POOL_MAX) {
    throw new PoolExhaustedError(`sandbox worker pool at capacity (${WORKER_POOL_MAX})`);
  }

  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  const sigView = new Int32Array(sab);
  const worker = new Worker(await workerEntryUrl(), {
    workerData: {
      wasmPath,
      moduleName,
      maxMemoryPages,
      sab,
      readBearingOps: READ_BEARING_OPS as readonly number[],
    },
    // resourceLimits is a soft hint to V8 — supports maxOldGenerationSizeMb,
    // maxYoungGenerationSizeMb, codeRangeSizeMb. Caps the worker's
    // JS heap (separate from the wasm linear memory ceiling).
    resourceLimits: {
      maxOldGenerationSizeMb: 32,
      maxYoungGenerationSizeMb: 8,
    },
  });

  // Per-worker bookkeeping. The same worker handles many invocations
  // serially; we update the bookkeeping on each invoke/result pair
  // via the worker's message handler.
  const key = poolKey(orgId, moduleName);
  const pooled: PooledWorker = {
    worker,
    key,
    orgId,
    moduleName,
    wasmPath,
    sab,
    sigView,
    invocationStartedAt: null,
    lastUsedAt: Date.now(),
    readyPromise: new Promise((resolveReady, rejectReady) => {
      const onReady = (msg: unknown) => {
        if ((msg as { type?: string }).type === "ready") {
          worker.off("message", onReady);
          resolveReady();
        }
      };
      worker.on("message", onReady);
      worker.once("error", (err) => rejectReady(err));
      worker.once("exit", (code) => {
        if (code !== 0) rejectReady(new Error(`worker exited code ${code} before ready`));
      });
    }),
    invocationChain: Promise.resolve(),
  };

  // Drain "kernel" / "kernel-sync" / "log" messages from in-flight
  // invocations. kernel-sync is the read-bearing path: the worker
  // is blocked on Atomics.wait + needs us to write the response
  // into the SAB before notifying.
  worker.on("message", (msg: unknown) => {
    const m = msg as { type: string; id?: string; op?: number; args?: unknown };
    if (m.type === "kernel") {
      // HOST_RESPOND is intercepted here so we have the invocation
      // id without threading it through handleKernelCall's signature.
      if (m.op === OP.HOST_RESPOND) {
        const a = (m.args ?? {}) as Record<string, unknown>;
        const body = String(a.body ?? "");
        const status =
          typeof a.status === "number" && a.status >= 100 && a.status <= 599 ? a.status : 200;
        if (m.id) inflightResponse.set(m.id, { body, status });
        return;
      }
      const ctx = inflightContext.get(m.id ?? "") ?? null;
      if (!ctx) return;
      handleKernelCall(ctx, m.op ?? 0, m.args).catch((err) =>
        console.error(`[sandbox-pool] kernel call failed:`, err),
      );
    } else if (m.type === "kernel-sync") {
      const ctx = inflightContext.get(m.id ?? "") ?? null;
      if (!ctx) {
        // No context — release the worker rather than hang it.
        signalReady(pooled, new Uint8Array(0));
        return;
      }
      void handleSyncKernelCall(pooled, ctx, m.op ?? 0, m.args);
    }
  });

  worker.on("error", (err) => {
    console.error(`[sandbox-pool] worker ${key} error:`, err);
    retire(key, "error");
  });

  pool.set(key, pooled);
  ensureEvictTimer();
  return pooled;
}

/** Per-invocation context indexed by invocation id. Used by the
 *  worker's "kernel" message handler to know whose tenant the
 *  platform call belongs to. */
const inflightContext = new Map<string, InvocationContext>();

// ─── CPU accounting + invocation telemetry ─────────────────────
//
// One ring per workspace + a separate one keyed by (workspace,
// module) so super-admin can attribute by-module too.
type CpuSample = { at: number; ms: number; module: string };
const cpuByWorkspace = new Map<string, CpuSample[]>();

/** Per-(workspace, module) invocation counters + recent latency
 *  samples for p50/p95 reporting. Samples drop after the CPU
 *  window expires (60s default). */
interface ModuleTelemetry {
  invocations: number;
  errors: number;
  /** Recent ms latencies — capped at TELEMETRY_LATENCY_RING_SIZE. */
  latencies: number[];
}
const TELEMETRY_LATENCY_RING_SIZE = 200;
const telemetryByKey = new Map<string, ModuleTelemetry>();

function recordInvocation(
  orgId: string,
  moduleName: string,
  ms: number,
  ok: boolean,
): void {
  const key = `${orgId}::${moduleName}`;
  let t = telemetryByKey.get(key);
  if (!t) {
    t = { invocations: 0, errors: 0, latencies: [] };
    telemetryByKey.set(key, t);
  }
  t.invocations++;
  if (!ok) t.errors++;
  t.latencies.push(ms);
  if (t.latencies.length > TELEMETRY_LATENCY_RING_SIZE) {
    t.latencies.splice(0, t.latencies.length - TELEMETRY_LATENCY_RING_SIZE);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

/** Read invocation telemetry per (workspace, module). Numbers are
 *  process-lifetime totals; the latency ring is bounded so p50/p95
 *  reflect recent history. Pairs with getCpuStats() in super-admin. */
export function getInvocationStats(): Array<{
  orgId: string;
  moduleName: string;
  invocations: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  recentSamples: number;
}> {
  const out: Array<{
    orgId: string;
    moduleName: string;
    invocations: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    recentSamples: number;
  }> = [];
  for (const [key, t] of telemetryByKey) {
    const [orgId, moduleName] = key.split("::");
    const sorted = [...t.latencies].sort((a, b) => a - b);
    out.push({
      orgId: orgId!,
      moduleName: moduleName!,
      invocations: t.invocations,
      errors: t.errors,
      errorRate: t.invocations > 0 ? t.errors / t.invocations : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      recentSamples: sorted.length,
    });
  }
  out.sort((a, b) => b.invocations - a.invocations);
  return out;
}

function recordCpu(orgId: string, moduleName: string, ms: number): void {
  if (ms <= 0) return;
  const arr = cpuByWorkspace.get(orgId);
  if (arr) arr.push({ at: Date.now(), ms, module: moduleName });
  else cpuByWorkspace.set(orgId, [{ at: Date.now(), ms, module: moduleName }]);
}

function pruneCpu(orgId: string): CpuSample[] {
  const arr = cpuByWorkspace.get(orgId);
  if (!arr) return [];
  const cutoff = Date.now() - CPU_WINDOW_MS;
  // Trim from the front — samples are append-only so the array is
  // already chronological.
  let firstIn = 0;
  while (firstIn < arr.length && arr[firstIn]!.at < cutoff) firstIn++;
  if (firstIn > 0) arr.splice(0, firstIn);
  if (arr.length === 0) cpuByWorkspace.delete(orgId);
  return arr;
}

function cpuUsageMs(orgId: string): number {
  const arr = pruneCpu(orgId);
  let total = 0;
  for (const s of arr) total += s.ms;
  return total;
}

/** Read CPU usage per workspace (+ per-module breakdown) for the
 *  super-admin dashboard. Returns the current sliding-window snapshot. */
export function getCpuStats(): {
  windowMs: number;
  quotaMsPerWindow: number;
  workspaces: Array<{
    orgId: string;
    usedMs: number;
    samples: number;
    byModule: Record<string, number>;
  }>;
} {
  const workspaces: Array<{
    orgId: string;
    usedMs: number;
    samples: number;
    byModule: Record<string, number>;
  }> = [];
  for (const orgId of cpuByWorkspace.keys()) {
    const arr = pruneCpu(orgId);
    if (arr.length === 0) continue;
    const byModule: Record<string, number> = {};
    let total = 0;
    for (const s of arr) {
      total += s.ms;
      byModule[s.module] = (byModule[s.module] ?? 0) + s.ms;
    }
    workspaces.push({
      orgId,
      usedMs: total,
      samples: arr.length,
      byModule,
    });
  }
  workspaces.sort((a, b) => b.usedMs - a.usedMs);
  return {
    windowMs: CPU_WINDOW_MS,
    quotaMsPerWindow: CPU_QUOTA_MS_PER_WINDOW,
    workspaces,
  };
}
/** Per-invocation response captured via HOST_RESPOND. The route
 *  handler reads from this after the invocation completes. */
const inflightResponse = new Map<string, { body: string; status: number }>();

let nextInvocationId = 1;

export async function invoke(ctx: InvocationContext, exportName: string): Promise<InvocationResult> {
  // CPU quota gate — short-circuit BEFORE spawning anything so a
  // workspace pinned at its quota can't even start new work.
  const used = cpuUsageMs(ctx.orgId);
  if (used >= CPU_QUOTA_MS_PER_WINDOW) {
    return {
      ok: false,
      logs: [],
      kernelCalls: 0,
      cpuQuotaExceeded: true,
      error: `workspace cpu quota exceeded: ${used}ms / ${CPU_QUOTA_MS_PER_WINDOW}ms in last ${CPU_WINDOW_MS}ms`,
    };
  }
  // Per-workspace concurrency gate. Reserve the slot synchronously
  // (before any await) so a burst can't all pass the check at once.
  const inflight = inflightByOrg.get(ctx.orgId) ?? 0;
  if (inflight >= MAX_CONCURRENCY_PER_WS) {
    return {
      ok: false,
      logs: [],
      kernelCalls: 0,
      concurrencyExceeded: true,
      error: `workspace concurrency limit reached (${MAX_CONCURRENCY_PER_WS} invocations in flight)`,
    };
  }
  inflightByOrg.set(ctx.orgId, inflight + 1);
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    const c = (inflightByOrg.get(ctx.orgId) ?? 1) - 1;
    if (c <= 0) inflightByOrg.delete(ctx.orgId);
    else inflightByOrg.set(ctx.orgId, c);
  };

  const key = poolKey(ctx.orgId, ctx.moduleName);
  let pooled = pool.get(key);
  if (!pooled) {
    try {
      pooled = await spawnWorker(ctx.orgId, ctx.moduleName, ctx.wasmPath, ctx.maxMemoryPages);
    } catch (err) {
      releaseSlot();
      if (err instanceof PoolExhaustedError) {
        return { ok: false, logs: [], kernelCalls: 0, poolExhausted: true, error: err.message };
      }
      throw err;
    }
  }
  try {
    await pooled.readyPromise;
  } catch (err) {
    releaseSlot();
    throw err;
  }

  // Serialise invocations into this worker by chaining onto the
  // previous invocation's promise. Each link resolves with the
  // current invocation's result; subsequent links wait.
  const runMine = async (): Promise<InvocationResult> => {
    // Re-check pool — a previous invocation in the chain might have
    // hit a deadline + caused the worker to be retired.
    let current = pool.get(key);
    if (!current) {
      try {
        current = await spawnWorker(ctx.orgId, ctx.moduleName, ctx.wasmPath, ctx.maxMemoryPages);
        await current.readyPromise;
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return { ok: false, logs: [], kernelCalls: 0, poolExhausted: true, error: err.message };
        }
        throw err;
      }
    }
    pooled = current;
    const invocationId = String(nextInvocationId++);
    // Per-invocation AbortController. Aborted on deadline-timeout
    // or worker-exit; read by runHostFetch to cancel any in-flight
    // outbound HTTP so a fetch doesn't outlive the wasm that
    // started it.
    const abortController = new AbortController();
    const ctxWithAbort: InvocationContext = { ...ctx, abortSignal: abortController.signal };
    inflightContext.set(invocationId, ctxWithAbort);
    const startMs = Date.now();
    pooled.invocationStartedAt = startMs;
    try {
      const result = await runInvocation(pooled, invocationId, exportName, ctxWithAbort, abortController);
      const respond = inflightResponse.get(invocationId);
      if (respond) {
        result.responseBody = respond.body;
        result.responseStatus = respond.status;
      }
      const elapsed = Date.now() - startMs;
      result.cpuMs = elapsed;
      recordCpu(ctx.orgId, ctx.moduleName, elapsed);
      recordInvocation(ctx.orgId, ctx.moduleName, elapsed, result.ok);
      return result;
    } finally {
      inflightContext.delete(invocationId);
      inflightResponse.delete(invocationId);
      // pooled may have been retired during runInvocation; check.
      if (pool.get(key) === pooled) {
        pooled.invocationStartedAt = null;
        pooled.lastUsedAt = Date.now();
      }
    }
  };

  const next = pooled.invocationChain.then(runMine, runMine);
  pooled.invocationChain = next.catch(() => undefined);
  // Release the workspace concurrency slot once this invocation settles
  // (success or failure), passing the result/rejection through.
  return next.finally(releaseSlot);
}

function runInvocation(
  pooled: PooledWorker,
  invocationId: string,
  exportName: string,
  ctx: InvocationContext,
  abortController: AbortController,
): Promise<InvocationResult> {
  const deadlineMs = ctx.deadlineMs ?? DEFAULT_DEADLINE_MS;
  return new Promise<InvocationResult>((resolveInvocation) => {
    const onMessage = (msg: unknown) => {
      const m = msg as {
        type: string;
        id?: string;
        logs?: Array<{ level: number; message: string }>;
        kernelCalls?: number;
        ok?: boolean;
        error?: string;
      };
      if (m.type !== "result" || m.id !== invocationId) return;
      cleanup();
      resolveInvocation({
        ok: m.ok === true,
        logs: m.logs ?? [],
        kernelCalls: m.kernelCalls ?? 0,
        error: m.error,
      });
    };
    const deadlineTimer = setTimeout(() => {
      cleanup();
      retire(pooled.key, "deadline");
      // Cancel any host-side fetch the wasm started — otherwise
      // an outbound HTTP call outlives the wasm + drains memory.
      abortController.abort(new Error("invocation deadline exceeded"));
      resolveInvocation({
        ok: false,
        logs: [],
        kernelCalls: 0,
        error: `deadline exceeded (${deadlineMs}ms)`,
        terminated: true,
      });
    }, deadlineMs);
    const onExit = (code: number) => {
      // Worker died unexpectedly mid-invocation.
      cleanup();
      abortController.abort(new Error(`worker exited code ${code}`));
      resolveInvocation({
        ok: false,
        logs: [],
        kernelCalls: 0,
        error: `worker exited code ${code}`,
        terminated: true,
      });
    };
    function cleanup() {
      pooled.worker.off("message", onMessage);
      pooled.worker.off("exit", onExit);
      clearTimeout(deadlineTimer);
    }
    pooled.worker.on("message", onMessage);
    pooled.worker.once("exit", onExit);
    pooled.worker.postMessage({ type: "invoke", id: invocationId, exportName });
  });
}

/** Translate a `host_platform_call` from the worker into the actual
 *  platform.* effect. Tenant-scoped to the invocation's bound
 *  context — the worker (and therefore the wasm) cannot pass an
 *  alternate orgId. */
async function handleKernelCall(
  ctx: InvocationContext,
  op: number,
  args: unknown,
): Promise<void> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (op) {
    case OP.ACTIVITY_LOG: {
      const action = String(a.action ?? "sandbox.invoked");
      const message = String(a.message ?? "");
      await meta
        .insertInto("activity_log")
        .values({
          org_id: ctx.orgId,
          user_id: ctx.userId,
          action: `sandbox:${ctx.moduleName}:${action}`,
          entity_type: "sandbox",
          entity_id: ctx.moduleName,
          module_name: ctx.moduleName,
          diff: sql`${JSON.stringify({ message })}::jsonb` as never,
        })
        .execute();
      return;
    }
    case OP.EVENT_EMIT: {
      const event = String(a.event ?? "");
      if (!event) return;
      const payload = (a.payload ?? {}) as Record<string, unknown>;
      // Namespace the event under the module name so subscribers
      // outside the sandbox see e.g. "hello-wasm.something" rather
      // than a wasm spoofing "inventory.stock.changed". orgId is
      // stamped on the payload from the host's bound context.
      //
      // SECURITY: the top-level namespace is ALWAYS the module name —
      // no exceptions. The wasm cannot opt out by pre-dotting the
      // event: a module passing "inventory.stock.changed" gets
      // "<module>.inventory.stock.changed" (its own namespace), never
      // the bare foreign name, so it can't fire another module's
      // subscribers. (Audit 2026-06-19 finding #4 — the old
      // `event.includes(".")` short-circuit WAS that opt-out.)
      const modPrefix = `${ctx.moduleName}.`;
      const bareEvent = event.startsWith(modPrefix) ? event.slice(modPrefix.length) : event;
      const namespaced = `${ctx.moduleName}.${bareEvent}`;
      const safePayload = { ...payload, orgId: ctx.orgId, __from_sandbox: ctx.moduleName };
      await platform().events.emit(namespaced, safePayload);
      return;
    }
    case OP.NOTIFICATION_SEND: {
      // Only allow notifying users WITHIN the bound workspace. The
      // host enforces the user_id is a member of ctx.orgId.
      // Sentinel: user_id === "self" resolves to the invoking user,
      // so the wasm can notify the caller without needing to know
      // their id.
      const requestedUserId = String(a.user_id ?? "");
      const userId = requestedUserId === "self" ? ctx.userId : requestedUserId;
      if (!userId) return;
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("org_id", "=", ctx.orgId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!member) {
        console.warn(
          `[sandbox:${ctx.moduleName}] NOTIFICATION_SEND blocked: user ${userId} not a member of ${ctx.orgId}`,
        );
        return;
      }
      const message = String(a.message ?? a.body ?? a.title ?? "");
      const linkUrl = a.link_url ? String(a.link_url) : undefined;
      await platform().notifications.dispatch({
        orgId: ctx.orgId,
        userId,
        eventType: `sandbox:${ctx.moduleName}`,
        message,
        link_url: linkUrl,
        module: ctx.moduleName,
        entityType: "sandbox",
        entityId: ctx.moduleName,
      });
      return;
    }
    default:
      console.warn(`[sandbox:${ctx.moduleName}] unknown op code ${op}`);
  }
}

// ─── Read-bearing kernel handlers ──────────────────────────────────

/** Write a response payload into the worker's SAB and wake it via
 *  Atomics.notify. The worker is currently blocked on Atomics.wait
 *  at signal=PENDING. Once we Atomics.store(READY)+notify, it
 *  resumes, reads length + bytes, copies into wasm memory. */
function signalReady(pooled: PooledWorker, payload: Uint8Array): void {
  if (payload.length > SAB_MAX_PAYLOAD_BYTES) {
    Atomics.store(pooled.sigView, SAB_LENGTH_OFFSET, payload.length);
    Atomics.store(pooled.sigView, SAB_SIGNAL_OFFSET, SAB_STATUS_TOO_BIG);
    Atomics.notify(pooled.sigView, SAB_SIGNAL_OFFSET, 1);
    return;
  }
  if (payload.length > 0) {
    const dst = new Uint8Array(pooled.sab, SAB_DATA_OFFSET_BYTES, payload.length);
    dst.set(payload);
  }
  Atomics.store(pooled.sigView, SAB_LENGTH_OFFSET, payload.length);
  Atomics.store(pooled.sigView, SAB_SIGNAL_OFFSET, SAB_STATUS_READY);
  Atomics.notify(pooled.sigView, SAB_SIGNAL_OFFSET, 1);
}

function signalError(pooled: PooledWorker): void {
  Atomics.store(pooled.sigView, SAB_LENGTH_OFFSET, 0);
  Atomics.store(pooled.sigView, SAB_SIGNAL_OFFSET, SAB_STATUS_ERROR);
  Atomics.notify(pooled.sigView, SAB_SIGNAL_OFFSET, 1);
}

const enc = new TextEncoder();
function encodeReply(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

async function handleSyncKernelCall(
  pooled: PooledWorker,
  ctx: InvocationContext,
  op: number,
  args: unknown,
): Promise<void> {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (op) {
      case OP.TENANT_QUERY: {
        const result = await runTenantQuery(ctx, a, "read");
        signalReady(pooled, encodeReply(result));
        return;
      }
      case OP.TENANT_EXEC: {
        const result = await runTenantQuery(ctx, a, "write");
        signalReady(pooled, encodeReply(result));
        return;
      }
      case OP.PAIRINGS_FIND_BY_TARGETS: {
        const items = await platform().pairings.findByTargets({
          orgId: ctx.orgId,
          sourceKind: String(a.source_kind ?? ""),
          targetKind: String(a.target_kind ?? ""),
          targetIds: Array.isArray(a.target_ids) ? (a.target_ids as string[]).map(String) : [],
          relationshipKind: String(a.relationship_kind ?? "matches"),
        });
        signalReady(pooled, encodeReply({ items }));
        return;
      }
      case OP.CATALOGS_QUERY_ENTRIES: {
        let catalogId = a.catalog_id ? String(a.catalog_id) : null;
        if (!catalogId && a.semantic_type) {
          const cat = await platform().catalogs.findBySemanticType(
            ctx.orgId,
            String(a.semantic_type),
          );
          catalogId = cat?.id ?? null;
        }
        if (!catalogId) {
          signalReady(pooled, encodeReply({ items: [], error: "catalog_not_found" }));
          return;
        }
        const items = await platform().catalogs.queryEntries({
          orgId: ctx.orgId,
          catalogId,
          payloadEq: a.payload_eq as Record<string, string> | undefined,
          externalIdIn: Array.isArray(a.external_id_in)
            ? (a.external_id_in as string[]).map(String)
            : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
        });
        // Project: external_id + payload only, dropping internal id
        // for now (the wasm has no use for it without further ops).
        signalReady(pooled, encodeReply({
          items: items.map((i) => ({
            id: i.id,
            external_id: i.externalId,
            payload: i.payload,
          })),
        }));
        return;
      }
      case OP.HOST_FETCH: {
        const result = await runHostFetch(ctx, a);
        signalReady(pooled, encodeReply(result));
        return;
      }
      case OP.HOST_GET_REQUEST_BODY: {
        const r = ctx.request ?? { body: null, query: {}, route: "" };
        signalReady(pooled, encodeReply({
          body: typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}),
          query: r.query,
          route: r.route,
        }));
        return;
      }
      default:
        console.warn(`[sandbox:${ctx.moduleName}] unknown read op ${op}`);
        signalError(pooled);
    }
  } catch (err) {
    console.error(`[sandbox:${ctx.moduleName}] sync kernel call ${op} threw:`, err);
    signalError(pooled);
  }
}

/** TENANT_QUERY / TENANT_EXEC runner. Enforces the module's
 *  table-prefix on every table referenced in the SQL — modules
 *  can only touch their own rows. Parameters bind positionally:
 *  the SQL uses `?` placeholders, which we translate to `$1..$n`
 *  before handing off to Postgres. No string concatenation.
 *
 *  `mode`:
 *    "read"  — SELECT only (TENANT_QUERY). Returns { rows }.
 *    "write" — INSERT/UPDATE/DELETE only (TENANT_EXEC). Returns
 *              { rowsAffected, rows? } where rows is populated
 *              when args.returning === true (RETURNING * appended). */
async function runTenantQuery(
  ctx: InvocationContext,
  a: Record<string, unknown>,
  mode: "read" | "write",
): Promise<{
  rows?: Array<Record<string, unknown>>;
  rowsAffected?: number;
  error?: string;
}> {
  const sqlText = String(a.sql ?? "").trim();
  if (!sqlText) return { rows: [], error: "empty_sql" };
  const params = Array.isArray(a.params) ? (a.params as unknown[]) : [];
  const prefix = ctx.tablePrefix || `${ctx.moduleName.replace(/-/g, "_")}_`;

  // Strip comments BEFORE any policy checks so /* SELECT */ INSERT
  // (or `-- benign comment\nDROP …`) can't paper over the real
  // statement class. Both line + block comment forms.
  const stripped = sqlText
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();

  // Multi-statement guard. We only allow one statement per invocation —
  // a module that wants "SELECT … ; INSERT …" can call TENANT_QUERY +
  // TENANT_EXEC separately. Allowing semicolons inside a single SQL
  // means the leading-statement-class gate below is bypassable
  // ("SELECT 1; DROP TABLE secret_table" passes the SELECT check).
  // Trailing semicolons are permitted because they're idiomatic; any
  // non-whitespace AFTER the (last) semicolon is a second statement.
  if (containsMultipleStatements(stripped)) {
    return {
      rows: [],
      rowsAffected: 0,
      error: "multi-statement SQL not allowed: split into separate TENANT_QUERY/TENANT_EXEC calls",
    };
  }

  // Lex-pass: find every bare-table identifier and confirm prefix.
  // Covers FROM/JOIN/INTO/UPDATE patterns. Also handles:
  //   - quoted identifiers:   FROM "users"
  //   - schema qualification: FROM public.users  (rejected — must
  //     not reach outside the tenant's default schema)
  // Misses CTE shadowing + window functions; modules wanting more
  // should confine queries to simple statements against their own
  // tables.
  const tableRefRe =
    /\b(?:from|join|into|update)\s+("?[A-Za-z_][A-Za-z0-9_]*"?)(\s*\.\s*("?[A-Za-z_][A-Za-z0-9_]*"?))?/gi;
  const refs: Array<{ raw: string; qualified: boolean }> = [];
  for (const m of stripped.matchAll(tableRefRe)) {
    if (m[3]) {
      refs.push({ raw: `${unquoteIdent(m[1]!)}.${unquoteIdent(m[3])}`, qualified: true });
    } else {
      refs.push({ raw: unquoteIdent(m[1]!), qualified: false });
    }
  }
  // Comma-separated table lists (implicit cross join). The regex above only
  // captures the FIRST table after FROM/JOIN, so `FROM mymod_x, inventory_parts`
  // left the second table UNCHECKED — a cross-module read bypass that defeated
  // the `reads` allowlist. (2026-06-10 pre-launch audit.)
  refs.push(...commaListTables(stripped));
  // `USING` tables (DELETE … USING a, b) — never reached by the
  // FROM/JOIN regex above. (2026-06-19 audit #1a.)
  refs.push(...usingTables(stripped));
  const allowed = ctx.allowedReadTables ?? new Set<string>();
  for (const ref of refs) {
    if (ref.qualified) {
      // We don't grant cross-schema access at all. Modules read/write
      // their own tables in the tenant's default schema; the only
      // cross-table access goes through the `reads` declaration,
      // which is unqualified by design.
      return {
        rows: [],
        rowsAffected: 0,
        error: `schema-qualified identifier '${ref.raw}' is not permitted; reference unqualified table names only`,
      };
    }
    if (ref.raw.startsWith(prefix)) continue;
    // Cross-module reads only on the SELECT path. TENANT_EXEC
    // (mode==="write") cannot reach outside its own prefix.
    if (mode === "read" && allowed.has(ref.raw)) continue;
    return {
      rows: [],
      rowsAffected: 0,
      error: `table '${ref.raw}' violates prefix policy: module ${ctx.moduleName} may only query tables starting with '${prefix}' (or one of the declared 'reads' tables on SELECT)`,
    };
  }

  // Statement-class gate. Operates on the de-commented SQL so a
  // sneaky `/* SELECT */ DROP TABLE` doesn't slide through.
  const isSelect = /^\s*(?:with\b[\s\S]*?)?select\b/i.test(stripped);
  const isWrite = /^\s*(?:with\b[\s\S]*?)?(insert|update|delete)\b/i.test(stripped);
  if (mode === "read" && !isSelect) {
    return { rows: [], error: "only SELECT statements allowed in TENANT_QUERY" };
  }
  // Read-path can't smuggle a write via a data-modifying CTE / SELECT
  // INTO. This is what stops a `reads` grant from being escalated into
  // a cross-module DELETE/UPDATE. (2026-06-19 audit #1b.)
  if (mode === "read") {
    const forbidden = forbiddenReadConstruct(stripped);
    if (forbidden) return { rows: [], error: forbidden };
  }
  if (mode === "write" && !isWrite) {
    return {
      rowsAffected: 0,
      error: "only INSERT/UPDATE/DELETE statements allowed in TENANT_EXEC",
    };
  }

  // Translate `?` → `$1..$n`. We walk the string outside of string
  // literals so that '?' inside a quoted text doesn't get bound.
  // Single + dollar-quoted strings, both honored.
  const { translated, paramCount } = translatePlaceholders(stripped);
  if (paramCount !== params.length) {
    return {
      error: `param count mismatch: SQL has ${paramCount} placeholder(s), got ${params.length}`,
    };
  }

  // Statement_timeout bounds runaway tenant queries — a module
  // doing `SELECT pg_sleep(99999)` or building a 30-table cartesian
  // join shouldn't be able to hold a Postgres backend forever.
  // We check out a dedicated client so the SET LOCAL doesn't bleed
  // into other queries sharing the pool. The wall-clock cap here
  // (default 10s) is independent of the worker's CPU quota — both
  // need to trip; statement_timeout is the database-side gate, the
  // CPU quota is the host-side gate.
  const SQL_TIMEOUT_MS = Number(process.env.SANDBOX_SQL_TIMEOUT_MS ?? 10_000);
  const pool = await getTenantPool(ctx.orgId);
  const client = await pool.connect();
  try {
    // SET LOCAL only applies inside a transaction, so wrap.
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(100, SQL_TIMEOUT_MS)}`);
    // DB-level isolation: drop to the module's own Postgres role (granted
    // ONLY its own + declared-reads tables) for the duration of this
    // statement, so Postgres enforces table access even if the SQL lexer
    // missed something. Only when the role is provisioned in this process
    // (graceful fallback to lexer-only otherwise). SET LOCAL ROLE resets
    // on COMMIT/ROLLBACK. (Audit follow-up #1.)
    if (isModuleRoleReady(ctx.orgId, ctx.moduleName)) {
      await client.query(`SET LOCAL ROLE "${moduleRoleName(ctx.orgId, ctx.moduleName)}"`);
    }
    const result = await client.query<Record<string, unknown>>(translated, params);
    await client.query("COMMIT");
    if (mode === "read") {
      return { rows: result.rows };
    }
    // pg's result.rowCount is the count of affected rows;
    // result.rows is populated when the SQL had RETURNING *.
    return {
      rowsAffected: result.rowCount ?? 0,
      rows: result.rows,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The client may already be in a bad state (timeout, lost
      // connection); rollback failure is best-effort.
    }
    return {
      rows: [],
      rowsAffected: 0,
      error: (err as Error).message,
    };
  } finally {
    client.release();
  }
}

// unquoteIdent + containsMultipleStatements moved to ./sql-guards.ts
// so unit tests can cover them without dragging worker_threads + the
// wasm runtime through Vite's transform.

/** Walk SQL outside of string literals + replace `?` with $N
 *  positional placeholders. Honors single-quoted strings (with ''
 *  escape) and dollar-quoted strings. Returns the rewritten SQL +
 *  the count of placeholders found. */
function translatePlaceholders(sqlIn: string): { translated: string; paramCount: number } {
  let out = "";
  let i = 0;
  let n = 0;
  while (i < sqlIn.length) {
    const c = sqlIn[i]!;
    // Single-quoted string. Escape via doubled single quote.
    if (c === "'") {
      out += c;
      i++;
      while (i < sqlIn.length) {
        const cc = sqlIn[i]!;
        out += cc;
        i++;
        if (cc === "'") {
          if (sqlIn[i] === "'") {
            out += sqlIn[i++];
            continue;
          }
          break;
        }
      }
      continue;
    }
    // Dollar-quoted string $tag$...$tag$.
    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlIn.slice(i));
      if (tagMatch) {
        const closing = tagMatch[0];
        out += closing;
        i += closing.length;
        const end = sqlIn.indexOf(closing, i);
        if (end === -1) {
          out += sqlIn.slice(i);
          i = sqlIn.length;
        } else {
          out += sqlIn.slice(i, end + closing.length);
          i = end + closing.length;
        }
        continue;
      }
    }
    if (c === "?") {
      n++;
      out += `$${n}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { translated: out, paramCount: n };
}

/** HOST_FETCH runner. Enforces the manifest's network[] allowlist + the
 *  SSRF guard on every hop, strips hop-by-hop headers, caps body size,
 *  and follows redirects MANUALLY (re-validating each) so an allowlisted
 *  host can't 30x-redirect the request to an internal target. */
async function runHostFetch(
  ctx: InvocationContext,
  a: Record<string, unknown>,
): Promise<{
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}> {
  if (!a.url) return { error: "empty_url" };
  const allowlist = ctx.network ?? [];
  // 5 MiB cap on response body — keeps the SAB-bounded transfer
  // possible without truncating mid-byte. Modules that need larger
  // payloads should paginate.
  const MAX_BODY = 5 * 1024 * 1024;
  const MAX_REDIRECTS = 5;

  let method = String(a.method ?? "GET").toUpperCase();
  const headers = (a.headers ?? {}) as Record<string, string>;
  // Strip headers a sandboxed module shouldn't be able to set —
  // host, cookie, authorization to internal targets, etc. Keep the
  // egress identity controlled by the host.
  const blocked = new Set(["host", "cookie", "set-cookie", "authorization", "x-forwarded-for"]);
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) safeHeaders[k] = String(v);
  }
  // Always identify the fetch as coming from a sandboxed module.
  safeHeaders["User-Agent"] = `cobblr-sandbox/${ctx.moduleName}`;
  let body: string | undefined =
    a.body !== undefined && method !== "GET" && method !== "HEAD" ? String(a.body) : undefined;

  // The shared pinnedRedirectingFetch owns the redirect + per-hop pin loop; the
  // sandbox policy is validateFetchTarget (manifest allowlist + private-block),
  // adapted to the callback's throw-to-block contract. ctx.abortSignal fires when
  // the invocation deadline trips or the worker dies, so a hung-server fetch does
  // not outlive the wasm. Every failure — a blocked hop, too-many-redirects, an
  // invalid Location, an abort — reduces to { error }, preserving the original
  // strings (the shared errors carry the same messages).
  let result: PinnedFetchResult;
  try {
    result = await pinnedRedirectingFetch({
      url: String(a.url),
      method,
      headers: safeHeaders,
      body,
      signal: ctx.abortSignal,
      maxRedirects: MAX_REDIRECTS,
      validate: async (u) => {
        const target = await validateFetchTarget(u.href, allowlist);
        if ("error" in target) throw new Error(target.error);
        return target.pin;
      },
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
  const { response, dispatcher } = result;
  try {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_BODY) {
      return { error: `response too large (${buf.byteLength}B > ${MAX_BODY}B cap)` };
    }
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });
    return {
      status: response.status,
      headers: respHeaders,
      body: new TextDecoder().decode(buf),
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    // The final hop's pinned Agent — the sandbox reads the whole body above, so
    // close it now rather than leaving it for the reaper.
    await dispatcher?.close().catch(() => {});
  }
}

/** Hot-reload helper: retire every pooled worker whose wasm artifact
 *  matches `wasmPath`. The next invocation spawns a fresh worker
 *  reading the new bytes. Returns the number of workers retired. */
export function retireWorkersForWasmPath(wasmPath: string): number {
  let n = 0;
  for (const [key, p] of [...pool.entries()]) {
    if (p.wasmPath === wasmPath) {
      retire(key, "error"); // reuse "error" reason since hot-reload is dev-only
      n++;
    }
  }
  return n;
}

/** Test-only — drains the pool. The next invocation spawns fresh. */
export async function _drainPool(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  for (const p of all) await p.worker.terminate().catch(() => {});
}

export function _poolSize(): number {
  return pool.size;
}
