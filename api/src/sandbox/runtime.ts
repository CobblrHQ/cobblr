// Marketplace v0.3 sandbox public entry — delegates to the worker
// pool. The actual wasm work happens in a worker_thread (see
// pool.ts + worker-entry.ts) so a hostile module can't block the
// host event loop. The pool lazily spawns workers per (workspace,
// module), terminates them on deadline, idle-evicts after 5 min.
//
// This module exists as a stable import for the loader / future
// callers; the pool's internals are private.

import { invoke as poolInvoke, type InvocationContext, type InvocationResult } from "./pool.js";

export interface SandboxInvocationContext {
  orgId: string;
  userId: string;
  moduleName: string;
  /** Path to the module.wasm to load. */
  wasmPath: string;
  /** Manifest's max_memory_pages — enforced at instance create time. */
  maxMemoryPages: number;
  /** Optional deadline; defaults to SANDBOX_DEFAULT_DEADLINE_MS env or 1000ms. */
  deadlineMs?: number;
  /** Network egress allowlist for HOST_FETCH ops. */
  network?: string[];
  /** SQL table prefix for TENANT_QUERY ops. */
  tablePrefix?: string;
  /** Cross-module read allowlist. */
  allowedReadTables?: Set<string>;
  /** Inbound request, for HOST_GET_REQUEST_BODY. */
  request?: { body: unknown; query: Record<string, string>; route: string };
}

export type { InvocationResult };

export async function invokeSandbox(
  exportName: string,
  ctx: SandboxInvocationContext,
): Promise<InvocationResult> {
  const fullCtx: InvocationContext = {
    orgId: ctx.orgId,
    userId: ctx.userId,
    moduleName: ctx.moduleName,
    wasmPath: ctx.wasmPath,
    maxMemoryPages: ctx.maxMemoryPages,
    deadlineMs: ctx.deadlineMs,
    network: ctx.network,
    tablePrefix: ctx.tablePrefix,
    allowedReadTables: ctx.allowedReadTables,
    request: ctx.request,
  };
  return poolInvoke(fullCtx, exportName);
}

/** Test-only — drains the worker pool. */
export { _drainPool, _poolSize } from "./pool.js";
