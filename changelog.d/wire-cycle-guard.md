---
type: fix
scope: wires
date: 2026-07-02
---
Wires can no longer loop forever. A wire whose action re-triggers its own event (say, "when stock changes, adjust stock") used to spin endlessly in the background; the engine now stops the chain after 8 hops and records a **wire_depth_exceeded** entry in the activity log so you can see exactly which wire cycled — normal multi-step wires are untouched.
