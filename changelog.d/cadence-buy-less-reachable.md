---
type: fix
date: 2026-08-10
scope: cadence
---

Two fixes to the predictive half of consumption tracking. The run-out signal now actually reaches your shopping list (it was publishing the wrong key, so the wire matched nothing and quietly never fired), and the buy-less insight, when most of something keeps going bad, is now sent to you instead of being emitted into thin air.
