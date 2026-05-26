# hello-wasm

The canonical **low-level ABI reference** for the Cobblr sandbox.
Hand-rolled WebAssembly Text format (WAT) → `module.wasm`, with
every byte through the ABI intentional and documented in source.

For **writing a real module**, use the AssemblyScript SDK + the
`hello-as` reference instead — see [`docs/SANDBOX_MODULE_AUTHORING.md`](../../docs/SANDBOX_MODULE_AUTHORING.md)
and `sandboxed-modules/hello-as/`. This module exists so the ABI's
shape is readable in 50 lines of WAT for anyone porting the SDK
to another language, debugging the kernel side, or proving a new
opcode out without an SDK in the way.

## What it does

`POST /api/v1/orgs/:slug/modules/hello-wasm/greet` invokes the
wasm's `handle` export. The wasm calls back into the host twice:

1. `host_log(level=1, "hello-wasm invoked")` — a debug line that
   shows up in the api container's stdout.
2. `host_platform_call(op=1 /*ACTIVITY_LOG*/, args)` — writes a row
   to `activity_log` tenant-scoped to the workspace that called.

Additional routes (`/emit`, `/notify-self`, `/spin`) exercise the
other ABI v1 opcodes + the deadline terminator. See `manifest.json`.

## Source

- `module.wat` — canonical source. Hand-rolled WAT (WebAssembly
  Text format). 50 lines.
- `module.wasm` — compiled artifact. The cobblr api loads this at
  boot; not generated on the fly.
- `manifest.json` — declarative description the host loader reads
  before instantiating the wasm.

## Rebuild after editing the WAT

```bash
cd <cobblr-core>
npx -p wabt wat2wasm sandboxed-modules/hello-wasm/module.wat \
  -o sandboxed-modules/hello-wasm/module.wasm
docker compose build api && docker compose up -d api
```

The api container picks up the new `.wasm` at boot. There's no
hot-reload yet.

## Why hand-written WAT instead of an SDK

Two reasons this module stays raw:

1. **The ABI documents itself.** WAT is the source of truth for
   "what bytes does the host see when wasm calls in." If the SDK
   ever drifts from the ABI contract, the diff against this
   module's WAT catches it.
2. **Porting the SDK to other languages.** Anyone writing a Rust
   or Zig SDK against the Cobblr sandbox starts by reading
   `module.wat` — it's the smallest end-to-end example that
   touches every part of the ABI without an intermediate
   abstraction in the way.

For day-to-day module development, use `hello-as` as the template
(`npx cobblr-sandbox-init <name>` scaffolds against it).

## ABI version

This module declares `abi_version: 1` and exercises only the v1
opcodes (write-only: ACTIVITY_LOG, EVENT_EMIT, NOTIFICATION_SEND).
The host is now at ABI v2 (read-bearing opcodes via SAB +
`Atomics.wait`) — backward-compatible, so v1 modules still load.

If the host moves to ABI v3 in a breaking way, the host refuses to
load this module; bump `abi_version` after rebuilding the WAT
against the new ABI.
