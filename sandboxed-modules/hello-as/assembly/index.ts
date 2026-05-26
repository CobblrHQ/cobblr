// AssemblyScript sample sandboxed module. Exercises every shipped
// kernel op (write + read) so the test harness can validate the
// loop end to end.

// NB: the published SDK lives at @cobblr/sandbox-sdk-as. AS's
// module resolution doesn't yet handle npm workspaces cleanly, so
// the cobblr-core repo vendors a copy in sdk.ts. External authors
// using a published SDK will use the npm package import directly:
//   import { ... } from "@cobblr/sandbox-sdk-as";
import {
  log,
  activityLog,
  eventEmit,
  notify,
  tenantQuery,
  pairingsFindByTargets,
  catalogsQueryEntries,
  fetchHost,
} from "./sdk";

// Re-export so AS keeps cobblr_alloc/cobblr_dealloc in the binary.
// The host runtime probes for these to pin host-allocated buffers.
export { cobblr_alloc, cobblr_dealloc } from "./sdk";

// ─── write-op handlers (v0.3) ────────────────────────────────────

export function handle(): void {
  log("hello-as invoked");
  activityLog("greet", "hello from AssemblyScript");
}

export function emit(): void {
  log("hello-as emit");
  eventEmit("greeted", '{"who":"world","via":"AS"}');
}

export function notify_self(): void {
  log("hello-as notify_self");
  notify("self", "hi from your AssemblyScript-authored sandboxed module");
}

// ─── read-op handlers (v0.3.x) ───────────────────────────────────

// Run a SELECT against the module's own tenant table. Note that
// 0001_init.sql creates hello_wasm_greetings — for the AS sample
// we re-use that table (same tenant, same prefix policy applies to
// hello_as_*; but the migration the host already runs sets up
// hello_wasm_*). For the test, we query a known-empty table from
// the module's own prefix.
export function query_self(): void {
  log("hello-as query_self");
  const json = tenantQuery("SELECT count(*)::text as n FROM hello_as_demo");
  activityLog("query_self", json);
}

// Negative test: try to read a table NOT in the hello_as_ prefix.
// The host's TENANT_QUERY validator should reject the query with
// a prefix-policy error.
export function query_other(): void {
  log("hello-as query_other");
  const json = tenantQuery("SELECT * FROM inventory_parts");
  activityLog("query_other", json);
}

// Negative test: attempt a non-SELECT (INSERT). Host should reject.
export function query_mutate(): void {
  log("hello-as query_mutate");
  const json = tenantQuery("INSERT INTO hello_as_demo (label) VALUES ('attempt')");
  activityLog("query_mutate", json);
}

export function pairings_probe(): void {
  log("hello-as pairings_probe");
  const json = pairingsFindByTargets(
    "inventory:part",
    "core-catalogs:entry",
    "[]",
  );
  activityLog("pairings_probe", json);
}

export function catalogs_probe(): void {
  log("hello-as catalogs_probe");
  // semantic_type lego.part may or may not be installed in the test
  // workspace; the host returns { items: [] } when no catalog
  // matches. Either way the read-op loop is exercised.
  const json = catalogsQueryEntries('{"semantic_type":"lego.part","limit":1}');
  activityLog("catalogs_probe", json);
}

export function fetch_blocked(): void {
  log("hello-as fetch_blocked");
  // Module's manifest declares network: [] — every fetch should be
  // rejected with { error: "host ... not in allowlist" }.
  const json = fetchHost("GET", "https://example.com/", "{}");
  activityLog("fetch_blocked", json);
}

export function fetch_allowed(): void {
  log("hello-as fetch_allowed");
  // localhost is on the manifest's allowlist. From inside the api
  // container, localhost:4000 hits the api itself — the /healthz
  // endpoint is unauthed + always returns 200, so this exercises
  // the full fetch loop without needing a flaky external dep.
  const json = fetchHost("GET", "http://localhost:4000/api/v1/healthz", "{}");
  activityLog("fetch_allowed", json);
}
