# {{PASCAL}}

A Cobblr v0.3 sandboxed module — runs in wasm with worker-thread
isolation, deadline termination, CPU quota, and (when declared)
network allowlist + cross-module DB reads.

## Quick start

```bash
npm install
npm run build       # writes module.wasm
```

Then either:
- **Local dev**: drop the whole dir into cobblr-core's
  `sandboxed-modules/{{NAME}}/`, restart the api. The sandbox
  loader picks it up at boot.
- **Publish**: tar (manifest.json + module.wasm + migrations + ui
  if present), sign with your ed25519 key
  (`scripts/sign-tarball.mjs` in cobblr-core), attach to a GitHub
  release, register in `cobblrhq/registry`. Workspace operators
  then click Install in /super-admin → Marketplace.

## What's in here

- `manifest.json` — declares routes, abi_version, network
  allowlist, optional `reads: { "<module>": ["table"] }` for
  cross-module SELECTs.
- `assembly/index.ts` — the wasm source. One `ping` handler that
  responds `{ ok: true, module: "{{NAME}}" }`.
- `assembly/sdk.ts` — vendored copy of `@cobblr/sandbox-sdk-as`.
  AS's npm-package resolver doesn't traverse workspace symlinks
  cleanly; vendoring is the supported workaround. Refresh via the
  cobblr-core monorepo's `packages/sandbox-sdk-as/scripts/vendor-into.mjs`.

## ABI

This module targets the cobblr sandbox ABI v2. See
[cobblr-core/docs/design-decisions/module-isolation.md](https://github.com/CobblrHQ/core/blob/main/docs/design-decisions/module-isolation.md)
for the kernel contract.

## Available kernel ops (via the SDK)

- `log(msg, level?)` — debug log to api stdout
- `activityLog(action, message)` — workspace activity_log entry
- `eventEmit(event, payloadJson)` — namespaced event
- `notify(userId, message, linkUrl?)` — notification
- `respond(bodyJson, status?)` — set the HTTP response
- `getRequestBody()` — read the inbound POST body
- `tenantQuery(sql, paramsJson?)` — SELECT against own tables
- `tenantExec(sql, paramsJson?)` — INSERT/UPDATE/DELETE against own tables
- `pairingsFindByTargets(sourceKind, targetKind, targetIdsJson, rel?)`
- `catalogsQueryEntries(argsJson)`
- `fetchHost(method, url, headersJson?, body?)` — outbound HTTP (allowlist-gated)

The host pins host-allocated buffers via `cobblr_alloc` (re-exported
from the SDK) so AS's GC doesn't reclaim them mid-read.
