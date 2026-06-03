// Marketplace v0.3 sandbox ABI — the contract between the kernel
// (host) and a sandboxed wasm module.
//
// This file is consumed BOTH by the host runtime and (in a future
// SDK) by module authors writing against the contract. Keep it
// stable; every change requires bumping ABI_VERSION + supporting
// the previous version in the host loader.
//
// Wire format: every host_platform_call passes JSON-encoded args
// in linear memory + receives a JSON-encoded response. Slow (~1ms
// per call) but predictable + easy to debug. Worth optimising
// later with a more compact format if benchmarks show it matters.
//
// See docs/architecture/module-isolation.md §4.3.

export const ABI_VERSION = 2 as const;

/** Op codes the wasm passes to host_platform_call. Each maps to
 *  exactly one platform.* method on the host. Adding a new op code
 *  is additive — existing modules using old op codes keep working.
 *
 *  Write-only ops (1-9): fire-and-forget; host returns 0 (no
 *  response_id). The wasm doesn't see the result.
 *
 *  Read-bearing ops (10+): the host writes the JSON response into a
 *  SharedArrayBuffer shared with the worker; the worker uses
 *  Atomics.wait to block synchronously; once notified, the worker
 *  copies the response into wasm linear memory via the wasm's
 *  __alloc export and returns a response_id. The wasm reads ptr/len
 *  via host_call_response_ptr / host_call_response_len, then must
 *  call host_call_response_free to release the slot. */
export const OP = {
  // ─── write-only ops ─────────────────────────────────────────
  ACTIVITY_LOG: 1,
  EVENT_EMIT: 2,
  NOTIFICATION_SEND: 3,
  /** Set the HTTP response body the host should send when the
   *  current handler returns. Args: { body: string, status?: number }.
   *  The host buffers the latest HOST_RESPOND per invocation; on
   *  handler return, if any HOST_RESPOND was issued, the host
   *  responds with that body (defaulting to status 200 + JSON
   *  content-type). Otherwise the default {ok, logs, kernel_calls}
   *  envelope. */
  HOST_RESPOND: 4,

  // ─── read-bearing ops ───────────────────────────────────────
  /** Query a module's OWN tenant tables. The host validates that
   *  every table name in the SQL starts with the module's table
   *  prefix (<module_name_underscored>_). SELECT only. Args:
   *    { sql: string, params?: unknown[] }
   *  Returns: { rows: Record<string, unknown>[] } */
  TENANT_QUERY: 10,
  /** Execute INSERT/UPDATE/DELETE against a module's OWN tenant
   *  tables. Same prefix policy as TENANT_QUERY. Args:
   *    { sql: string, params?: unknown[], returning?: boolean }
   *  Returns: { rowsAffected: number, rows?: Record<string, unknown>[] } */
  TENANT_EXEC: 14,
  /** Bulk inverse pairing lookup. Mirrors
   *  platform.pairings.findByTargets but JSON-shaped for the ABI.
   *  Args: {
   *    source_kind: string, target_kind: string,
   *    target_ids: string[], relationship_kind: string,
   *  }
   *  Returns: { items: { source_id, target_id }[] } */
  PAIRINGS_FIND_BY_TARGETS: 11,
  /** Catalog query. Mirrors platform.catalogs.queryEntries.
   *  Args: {
   *    semantic_type?: string, catalog_id?: string,
   *    payload_eq?: Record<string, string>, external_id_in?: string[],
   *    limit?: number,
   *  }
   *  Returns: { items: { id, external_id, payload }[] } */
  CATALOGS_QUERY_ENTRIES: 12,
  /** Network egress. Manifest's network[] allowlist gates the URL
   *  host. Args:
   *    { method, url, headers?, body? }
   *  Returns: { status, headers, body } */
  HOST_FETCH: 13,
  /** Read the inbound HTTP request body the route handler received.
   *  Args: ignored. Returns: { body: string, query: Record<string,
   *  string>, route: string }. The wasm parses to access fields.
   *  v0.4 will replace this with request/response marshalling on
   *  the handle() export itself; for now the side-channel keeps the
   *  WAT/AS export signature uniform across read-only and read-write
   *  modules. */
  HOST_GET_REQUEST_BODY: 15,
} as const;

export type OpCode = (typeof OP)[keyof typeof OP];

/** Read-bearing ops use a SharedArrayBuffer to pass the response
 *  back to the worker synchronously (Atomics.wait blocks). Layout:
 *    Int32Array slot 0:  signal — 0=pending, 1=ready, -1=error,
 *                                  -2=too-big-for-SAB.
 *    Int32Array slot 1:  response payload length (bytes).
 *    Bytes 8..:           response JSON (UTF-8). */
export const SAB_SIGNAL_OFFSET = 0;
export const SAB_LENGTH_OFFSET = 1; // i32 indices, not bytes
export const SAB_DATA_OFFSET_BYTES = 8;
/** Default SAB size — 2 MiB minus the 8-byte header. Big enough for
 *  most HTTP fetch responses (HTML pages, API JSON), large catalog
 *  result sets, and the typical tenant-query payload. Oversized
 *  responses fail cleanly with signal=-2 and the wasm sees
 *  response_id=0. Cost: 2 MiB × pool size (default 64) = 128 MiB
 *  worst case. Tunable via SANDBOX_SAB_BYTES env. */
export const SAB_TOTAL_BYTES = Number(process.env.SANDBOX_SAB_BYTES ?? 2 * 1024 * 1024);
export const SAB_MAX_PAYLOAD_BYTES = SAB_TOTAL_BYTES - SAB_DATA_OFFSET_BYTES;

export const SAB_STATUS_PENDING = 0;
export const SAB_STATUS_READY = 1;
export const SAB_STATUS_ERROR = -1;
export const SAB_STATUS_TOO_BIG = -2;

/** What the host imports into every wasm sandbox. The module
 *  declares matching imports in its WAT/Rust/AssemblyScript
 *  source under the import-namespace "host". */
export interface SandboxHostImports {
  /** Write a string to the api log. (level, msg_ptr, msg_len) →
   *  void. Level: 0=debug, 1=info, 2=warn, 3=error. */
  host_log(level: number, msgPtr: number, msgLen: number): void;
  /** Make a kernel call. (op, args_ptr, args_len) → response_id.
   *  Response is materialised in wasm-readable memory via
   *  host_call_response_ptr + host_call_response_len; the wasm
   *  reads the JSON, frees with host_call_response_free. */
  host_platform_call(opCode: number, argsPtr: number, argsLen: number): number;
  host_call_response_ptr(responseId: number): number;
  host_call_response_len(responseId: number): number;
  host_call_response_free(responseId: number): void;
}

/** What the wasm module must export. The host calls these via
 *  Instance.exports. */
export interface SandboxModuleExports {
  /** Linear memory the host reads + writes for arg passing. */
  memory: WebAssembly.Memory;
  /** Module's allocator. host_call_response_ptr returns a pointer
   *  into wasm memory that was allocated via __alloc. */
  __alloc?: (size: number) => number;
  /** Entry point called per request. Reads request via static
   *  conventions (PoC: hardcoded payload). v0.4 will pass
   *  (req_ptr, req_len) for full request marshalling. */
  handle: () => void;
}

import { z } from "zod";

/** Zod schema for SandboxedModuleManifest. Used at both image-
 *  build install + runtime install to catch malformed manifests
 *  with a structured error instead of a runtime crash later. */
export const SandboxedModuleManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "name must be kebab-case ascii"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver-ish"),
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  band: z.enum(["marketplace", "user"]),
  abi_version: z.number().int().positive(),
  routes: z
    .array(
      z.object({
        method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
        path: z.string().regex(/^\/[a-zA-Z0-9/_:-]*$/, "path must be /-prefixed ascii"),
        handler: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "handler must be a valid identifier"),
        deadline_ms: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(100),
  network: z.array(z.string().min(1).max(253)).default([]),
  reads: z.record(z.string(), z.array(z.string().min(1).max(120))).optional(),
  max_memory_pages: z.number().int().positive().max(2048),
});

/** The manifest a sandboxed module ships in its dir. Mirrors
 *  ModuleManifest but with isolation-specific fields added.
 *  Inferred from the schema so the two stay in lockstep. */
export interface SandboxedModuleManifest {
  /** Unique name (kebab-case). Same convention as in-process modules. */
  name: string;
  /** Semver. */
  version: string;
  /** Human-readable display. */
  displayName: string;
  description: string;
  /** Always "marketplace" or "user" for v0.3. Foundational / stock
   *  bands stay in-process — no reason to sandbox already-trusted
   *  Cobblr code. */
  band: "marketplace" | "user";
  /** The ABI version this module was built against. Host loader
   *  rejects a module whose abi_version > ABI_VERSION (the host
   *  hasn't been upgraded yet). */
  abi_version: number;
  /** Routes the module exposes. Each route is invoked by calling
   *  the wasm export named in `handler`. */
  routes: Array<{
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    handler: string;
    /** Per-handler deadline in ms. Defaults to the host's
     *  SANDBOX_DEFAULT_DEADLINE_MS (1000). Routes that do HOST_FETCH
     *  or heavy SQL should override; the host clamps the upper
     *  bound to SANDBOX_MAX_DEADLINE_MS (default 30000). */
    deadline_ms?: number;
  }>;
  /** Network egress allowlist. Empty = no network access (the host
   *  doesn't expose any fetch import). Each entry is a hostname
   *  (exact match) or a leading-dot wildcard (`.bricklink.com`
   *  matches both bricklink.com and api.bricklink.com). */
  network: string[];
  /** Cross-module read declaration. Maps a module name → list of
   *  its tables this module may SELECT (only — never write). The
   *  prefix-policy enforcer lets `<module_underscored>_<table>`
   *  through when the table is in this declaration. Example:
   *    "reads": { "inventory": ["parts"] }
   *  → this module may SELECT from `inventory_parts`. No effect
   *  on TENANT_EXEC (writes always require own-prefix). The named
   *  module must be enabled in the workspace, else SELECT errors. */
  reads?: Record<string, string[]>;
  /** Memory ceiling in pages (1 page = 64KiB). Host instantiates
   *  the wasm with max = this; growth beyond traps. */
  max_memory_pages: number;
}
