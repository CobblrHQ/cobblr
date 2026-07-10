---
type: feature
scope: wires
date: 2026-07-02
---
Wires can be picky now. Every wire gets an optional **"only when…"**: plain conditions like `event.newQty ≤ 5` or `material = PLA`, joined with AND, editable in the wire composer. The event still fires; the wire just declines politely unless all its conditions hold. Bundles can ship conditions too, and a typo'd condition is rejected at save instead of installing a wire that silently never runs.
