---
type: fix
scope: scan
date: 2026-07-11
---
**Sending a committed scan back no longer rewrites its scan time.** Un-confirming an item (Send back) used to stamp it with the current time, which dragged its whole scan session's header time and inbox position forward to the moment you undid it. Un-confirm is an undo, so the item now returns to its original spot with its original scan time intact; only its "last touched" time moves.
