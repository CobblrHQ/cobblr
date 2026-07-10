---
type: fix
scope: scan
date: 2026-07-10
---
Opening the guided put-away planner or Live Sort from a deep link no longer leaves `?organize=pending`, `?livesort=1`, or `?sort=1` stuck in the URL. Before, the parameter stayed behind, so every page refresh reopened the planner (or re-armed Sort mode even after you turned it off). These links now trigger once and clear themselves.
