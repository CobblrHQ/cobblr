---
type: improvement
scope: modules
date: 2026-06-21
---
Tidied the Modules list. The built-in wasm **demo modules** (hello-world examples + a sandbox URL archiver) were only ever there to exercise the platform's sandbox feature — they no longer appear in real workspaces (they load only when you're developing Cobblr itself). And **Maintenance** is now an optional module you can switch off if you don't use it — it was previously pinned on with no way to disable it.
