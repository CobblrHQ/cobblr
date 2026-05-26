// {{PASCAL}} — Cobblr v0.3 sandboxed module starter.

import { log, activityLog, respond } from "./sdk";

// Re-export so AS keeps cobblr_alloc/cobblr_dealloc in the binary.
// The host runtime probes for these to pin host-allocated buffers
// against AS's GC between the host writing them and the SDK reading.
export { cobblr_alloc, cobblr_dealloc } from "./sdk";

export function ping(): void {
  log("{{NAME}} ping");
  activityLog("ping", "{{NAME}} sandbox module reached");
  respond('{"ok":true,"module":"{{NAME}}"}', 200);
}
