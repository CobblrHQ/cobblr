---
type: fix
scope: dashboard
date: 2026-07-04
---
An empty **multi-instance** module (Projects, Inventory) no longer shows a permanent "0 / none yet" card on the dashboard. Its per-instance tile now collapses into the quiet "Also enabled" line exactly like every other empty module — and a stale duplicate (the module appearing in "Also enabled" *and* as a card) is gone: dashboard tiles now clean up their empty-state report when they're swapped out (which happens the moment a module's instances finish loading).
