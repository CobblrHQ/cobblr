---
type: improvement
scope: platform
date: 2026-07-10
---
Entity kinds can now declare a `listEndpoint` in their manifest, alongside the existing create/update/delete declarations. First-party generic surfaces (the floor plan's entity occupants, future pickers) enumerate a kind's rows through its module's own list route, with the module's own role gating, instead of hardcoding module names. Machines, assets, and parts declare it; any future module joins with one manifest line.
