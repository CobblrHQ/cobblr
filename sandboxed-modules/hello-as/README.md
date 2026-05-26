# hello-as

AssemblyScript-authored sandboxed module. Compiles to wasm via
[`asc`](https://www.assemblyscript.org/) and exercises the same
op codes as the hand-rolled-WAT `hello-wasm` sibling — proves the
SDK works end-to-end.

## Source layout

```
hello-as/
├── assembly/
│   ├── index.ts       # module source (TypeScript-like)
│   └── sdk.ts         # vendored copy of @cobblr/sandbox-sdk-as
├── manifest.json
├── module.wasm        # compiled artifact (~10 KB)
└── package.json
```

`assembly/sdk.ts` is a copy of the published SDK at
[`packages/sandbox-sdk-as/`](../../packages/sandbox-sdk-as/) — AS's
module resolution doesn't yet handle npm workspace symlinks
cleanly, so the SDK file ships vendored alongside the module source.
External authors using a real npm-installed SDK import directly:

```ts
import { log, activityLog, eventEmit, notify } from "@cobblr/sandbox-sdk-as";
```

## Rebuild

```bash
cd sandboxed-modules/hello-as
npm install
npm run build
docker compose -f ../../docker-compose.yml build api && docker compose up -d api
```

## What it demonstrates vs hello-wasm

Identical behaviour, different authoring story:

| Capability | hello-wasm (WAT) | hello-as (AS) |
|---|---|---|
| Hand-roll wasm pointers | yes | no — SDK does it |
| String escape JSON | hand-encoded `.data` | `jsonStr()` in SDK |
| Memory pin/unpin | implicit (no GC) | explicit (AS's `__pin`) |
| Final wasm size | 480 bytes | ~10 KB |
| Time to write a new module | ~30 min | ~5 min |

The SDK trade-off is binary size — AS's runtime adds ~10 KB
overhead. For modules that do meaningful work, that's a rounding
error. For "spin a single value" trivia, WAT is still leaner.

## ABI version

Manifest declares `abi_version: 1`. The SDK uses op codes that map
to ABI v1; bumping the host's ABI to v2 in a breaking way means
rebuilding against the new SDK.
