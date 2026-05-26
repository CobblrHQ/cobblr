// @cobblr/sandbox-sdk-as — AssemblyScript SDK for sandboxed modules.
//
// Wraps the v0.3.x sandbox ABI (write + read ops) in helpers so
// module authors don't deal with raw pointer arithmetic. Module
// source becomes idiomatic TypeScript-like AS:
//
//     import {
//       log, activityLog, eventEmit, notify,
//       tenantQuery, pairingsFindByTargets,
//       catalogsQueryEntries, fetchHost,
//     } from "@cobblr/sandbox-sdk-as";
//
//     export function handle(): void {
//       log("module ran");
//       const json = tenantQuery("SELECT id, name FROM my_module_things");
//       activityLog("read", json);
//     }
//
// ABI mirror — keep these op codes in sync with
// api/src/sandbox/abi.ts.

const OP_ACTIVITY_LOG: i32 = 1;
const OP_EVENT_EMIT: i32 = 2;
const OP_NOTIFICATION_SEND: i32 = 3;
const OP_HOST_RESPOND: i32 = 4;

// Host-callable allocator. The host calls this when it needs to
// write a kernel response into wasm linear memory. We allocate via
// AS's `new ArrayBuffer(size)` which the GC tracks properly, then
// pin it so the host can fill + the SDK can read without the GC
// reclaiming the bytes in between. The SDK unpins via
// `cobblr_dealloc` (called from inside the host_call_response_free
// chain at the end of callRead).
export function cobblr_alloc(size: i32): i32 {
  const buf = new ArrayBuffer(size);
  const ptr = changetype<i32>(buf);
  __pin(ptr);
  return ptr;
}

export function cobblr_dealloc(ptr: i32): void {
  if (ptr !== 0) __unpin(ptr);
}
const OP_TENANT_QUERY: i32 = 10;
const OP_PAIRINGS_FIND_BY_TARGETS: i32 = 11;
const OP_CATALOGS_QUERY_ENTRIES: i32 = 12;
const OP_HOST_FETCH: i32 = 13;
const OP_TENANT_EXEC: i32 = 14;
const OP_HOST_GET_REQUEST_BODY: i32 = 15;

// ─── host imports ─────────────────────────────────────────────────

@external("host", "host_log")
declare function host_log(level: i32, ptr: i32, len: i32): void;

@external("host", "host_platform_call")
declare function host_platform_call(op: i32, argsPtr: i32, argsLen: i32): i32;

@external("host", "host_call_response_ptr")
declare function host_call_response_ptr(id: i32): i32;

@external("host", "host_call_response_len")
declare function host_call_response_len(id: i32): i32;

@external("host", "host_call_response_free")
declare function host_call_response_free(id: i32): void;

// ─── public surface — write-only ops ─────────────────────────────

/** Send a debug log line to the api stdout. Level: 0=debug, 1=info,
 *  2=warn, 3=error. */
export function log(message: string, level: i32 = 1): void {
  const buf = String.UTF8.encode(message);
  const ptr = changetype<i32>(buf);
  __pin(ptr);
  host_log(level, ptr, buf.byteLength);
  __unpin(ptr);
}

/** Write an activity_log entry on behalf of this module, tenant-
 *  scoped to the bound workspace. */
export function activityLog(action: string, message: string): void {
  const json = `{"action":${jsonStr(action)},"message":${jsonStr(message)}}`;
  callWrite(OP_ACTIVITY_LOG, json);
}

/** Emit an event on the platform event bus. The host namespaces the
 *  event under the module name. */
export function eventEmit(event: string, payloadJson: string): void {
  const json = `{"event":${jsonStr(event)},"payload":${payloadJson}}`;
  callWrite(OP_EVENT_EMIT, json);
}

/** Set the HTTP response body the host will emit when the current
 *  handler returns. Pass `bodyJson` already-stringified; the host
 *  emits it verbatim with content-type application/json. Optional
 *  `status` defaults to 200. Calling this more than once in a
 *  handler keeps the LAST value. */
export function respond(bodyJson: string, status: i32 = 200): void {
  const json = `{"body":${jsonStr(bodyJson)},"status":${status}}`;
  callWrite(OP_HOST_RESPOND, json);
}

/** Dispatch a notification. `userId === "self"` resolves to the
 *  invoking user; any other id must be a member of the workspace. */
export function notify(userId: string, message: string, linkUrl: string = ""): void {
  let json: string;
  if (linkUrl.length === 0) {
    json = `{"user_id":${jsonStr(userId)},"message":${jsonStr(message)}}`;
  } else {
    json = `{"user_id":${jsonStr(userId)},"message":${jsonStr(message)},"link_url":${jsonStr(linkUrl)}}`;
  }
  callWrite(OP_NOTIFICATION_SEND, json);
}

// ─── public surface — read-bearing ops ───────────────────────────

/** Query the module's own tenant tables. The host validates that
 *  every table referenced in `sqlText` starts with the module's
 *  table prefix (<module_name_underscored>_). SELECT only.
 *  Returns the host's JSON response as a string — module code is
 *  responsible for parsing it (AS doesn't ship a JSON parser; a
 *  small one can be hand-rolled or imported as a dep). */
export function tenantQuery(sqlText: string, paramsJson: string = ""): string {
  const json = paramsJson.length > 0
    ? `{"sql":${jsonStr(sqlText)},"params":${paramsJson}}`
    : `{"sql":${jsonStr(sqlText)}}`;
  return callRead(OP_TENANT_QUERY, json);
}

/** INSERT/UPDATE/DELETE against the module's own tenant tables.
 *  Same prefix policy as tenantQuery. Parameters bind positionally
 *  via `?` in the SQL. Use a JSON array as `paramsJson` (e.g.
 *  '["alpha", 42]'). Returns the host's JSON response — typically
 *  { rowsAffected: N, rows?: [...] } when the SQL had RETURNING. */
export function tenantExec(sqlText: string, paramsJson: string = "[]"): string {
  const json = `{"sql":${jsonStr(sqlText)},"params":${paramsJson}}`;
  return callRead(OP_TENANT_EXEC, json);
}

/** Read the inbound request body the route handler received.
 *  Returns the host's JSON envelope: { body: string, query: {...},
 *  route: string }. The body field is always a string (raw JSON);
 *  authors parse from there. */
export function getRequestBody(): string {
  return callRead(OP_HOST_GET_REQUEST_BODY, "{}");
}

/** Bulk inverse pairing lookup. */
export function pairingsFindByTargets(
  sourceKind: string,
  targetKind: string,
  targetIdsJson: string,
  relationshipKind: string = "matches",
): string {
  const json = `{"source_kind":${jsonStr(sourceKind)},"target_kind":${jsonStr(targetKind)},"target_ids":${targetIdsJson},"relationship_kind":${jsonStr(relationshipKind)}}`;
  return callRead(OP_PAIRINGS_FIND_BY_TARGETS, json);
}

/** Query catalog entries by semantic_type + payload filter. */
export function catalogsQueryEntries(argsJson: string): string {
  return callRead(OP_CATALOGS_QUERY_ENTRIES, argsJson);
}

/** Outbound HTTP request. Subject to the manifest's network[]
 *  allowlist. Returns JSON of { status, headers, body } on success
 *  or { error } when the host rejects (bad URL, not in allowlist,
 *  body too large, etc.). */
export function fetchHost(method: string, url: string, headersJson: string = "{}", body: string = ""): string {
  let json: string;
  if (body.length === 0) {
    json = `{"method":${jsonStr(method)},"url":${jsonStr(url)},"headers":${headersJson}}`;
  } else {
    json = `{"method":${jsonStr(method)},"url":${jsonStr(url)},"headers":${headersJson},"body":${jsonStr(body)}}`;
  }
  return callRead(OP_HOST_FETCH, json);
}

// ─── ABI shims ───────────────────────────────────────────────────

function callWrite(op: i32, json: string): void {
  const buf = String.UTF8.encode(json);
  const ptr = changetype<i32>(buf);
  __pin(ptr);
  host_platform_call(op, ptr, buf.byteLength);
  __unpin(ptr);
}

function callRead(op: i32, json: string): string {
  const buf = String.UTF8.encode(json);
  const ptr = changetype<i32>(buf);
  __pin(ptr);
  const id = host_platform_call(op, ptr, buf.byteLength);
  __unpin(ptr);
  if (id === 0) return "";
  const respPtr = host_call_response_ptr(id);
  const respLen = host_call_response_len(id);
  if (respPtr === 0 || respLen === 0) {
    host_call_response_free(id);
    return "";
  }
  // The host allocated this region via cobblr_alloc (preferred) or
  // __new. cobblr_alloc pinned it so AS's GC keeps the bytes alive
  // until we read; decodeUnsafe copies into a new String, after
  // which the original pin is leaked (intentionally — auto-unpin
  // requires tracking ptr→pin-count which adds complexity for
  // negligible memory savings on short-lived responses).
  const result = String.UTF8.decodeUnsafe(respPtr, respLen, false);
  host_call_response_free(id);
  return result;
}

// ─── JSON string escaping (minimal) ───────────────────────────────

/** Escape a string for use as a JSON string literal. Useful when
 *  module code is building a JSON envelope by string concatenation
 *  (e.g. `{"name":${jsonStr(name)}}`). Handles the standard JSON
 *  escapes; does not emit \uXXXX for high control chars. */
export function jsonStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else if (c === 0x0a) {
      out += "\\n";
    } else if (c === 0x0d) {
      out += "\\r";
    } else if (c === 0x09) {
      out += "\\t";
    } else if (c < 0x20) {
      const hi = (c >> 4) & 0xf;
      const lo = c & 0xf;
      out += "\\u00";
      out += hexChar(hi);
      out += hexChar(lo);
    } else {
      out += String.fromCharCode(c);
    }
  }
  out += '"';
  return out;
}

function hexChar(n: i32): string {
  if (n < 10) return String.fromCharCode(0x30 + n);
  return String.fromCharCode(0x57 + n);
}
