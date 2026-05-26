# @cobblr/sandbox-sdk-as

AssemblyScript SDK for writing v0.3 sandboxed Cobblr modules. Targets
host **ABI version 2**.

For the full author tutorial (project scaffold, manifest, building,
deploy, debugging) see [`docs/SANDBOX_MODULE_AUTHORING.md`](../../docs/SANDBOX_MODULE_AUTHORING.md).
Scaffold a new module with:

```bash
npx cobblr-sandbox-init my-module
```

## Quick start

```ts
// assembly/index.ts in your module repo
import {
  log, activityLog, eventEmit, notify, respond,
  tenantQuery, tenantExec, getRequestBody,
  fetchHost,
} from "@cobblr/sandbox-sdk-as";

export function handle(): void {
  const body = getRequestBody();        // JSON envelope { body, query, route }
  log("module ran: " + body);
  activityLog("greet", "hello from an AssemblyScript module");
  eventEmit("greeted", '{"who":"world"}');
  notify("self", "you have a notification");

  // Read your own tenant tables (prefix-enforced):
  const rows = tenantQuery(
    "SELECT id, name FROM mymodule_things WHERE created_at > ?",
    '["2026-01-01"]',
  );

  // Outbound HTTP through the host (allowlist-enforced via manifest.network):
  const resp = fetchHost("GET", "https://api.example.com/ping");

  respond('{"ok":true}', 200);          // HTTP response body + status
}
```

Compile with [`asc`](https://www.assemblyscript.org/compiler.html):

```bash
npx asc assembly/index.ts \
  --outFile dist/module.wasm \
  --optimize \
  --runtime minimal
```

Then publish via the registry — see [`docs/MARKETPLACE_RUNBOOK.md`](../../docs/MARKETPLACE_RUNBOOK.md).

## SDK surface (ABI v2)

**Write-only ops** (return immediately, no host round-trip wait):

- `log(message, level?)` — write to the api stdout.
- `activityLog(action, message)` — write to the workspace's
  `activity_log` table tenant-scoped to the bound workspace.
- `eventEmit(event, payloadJson)` — emit on the platform event
  bus. Event name is namespaced under your module.
- `notify(userId, message, linkUrl?)` — dispatch a notification.
  `userId === "self"` resolves to the invoking user; any other
  id must be a member of the workspace or the host blocks it.
- `respond(bodyJson, status?)` — set the HTTP response body and
  status code. The last `respond` call before `handle` returns
  wins.

**Read-bearing ops** (worker blocks on `Atomics.wait` until the host
writes the JSON response back into the SharedArrayBuffer):

- `tenantQuery(sql, paramsJson?)` — run a SELECT against your
  module's tables (prefix-enforced: `<your_module_name>_*`, with
  `-` folded to `_`). Cross-module reads require declaring the
  table in `manifest.reads: { other_module: ["table_a"] }`. Returns
  the result row array as a JSON string.
- `tenantExec(sql, paramsJson?)` — INSERT/UPDATE/DELETE only; same
  prefix rules; returns `{ rowsAffected, rows? }` JSON.
- `pairingsFindByTargets(argsJson)` — bulk inverse pairings lookup;
  same signature as `platform.pairings.findByTargets`.
- `catalogsQueryEntries(argsJson)` — read from `catalog_entries`
  by `semantic_type` + `payload_eq` / `external_id_in`.
- `fetchHost(method, url, headersJson?, body?)` — outbound HTTP.
  URL host must match a `manifest.network[]` entry (exact host OR
  leading-`.` for subdomains). Body capped at 5 MiB. UA forced to
  `cobblr-sandbox/<module>`.
- `getRequestBody()` — returns the inbound POST envelope as a JSON
  string: `{ body, query, route }`.

All read ops are synchronous from the wasm side. The host enforces a
per-invocation deadline (default 30s); blowing it terminates the
worker.

## Pinning + memory

`String.UTF8.encode` allocates an `ArrayBuffer` whose underlying
bytes can move when AS's GC runs. The SDK pins the buffer via
`__pin` for the duration of the host call (which is synchronous
from the wasm's perspective) and unpins after. Authors writing
custom op codes should follow the same pattern.

`cobblr_alloc` / `cobblr_dealloc` are re-exported by every module
(via `export { cobblr_alloc, cobblr_dealloc } from "@cobblr/sandbox-sdk-as"`)
because the host probes for them to allocate response buffers
inside the wasm linear memory. **Forgetting to re-export them means
the module won't load** — the loader checks for both at register
time.

## ABI version

The SDK targets **ABI version 2**. Module manifests must declare
`abi_version: 2`. The host refuses to load a module whose
`abi_version > host_ABI`.
