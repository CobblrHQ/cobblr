---
type: fix
scope: scan
date: 2026-09-23
---
A scanned breadboard or beanbag chair no longer lands in Groceries. The router counted a food word inside a longer word ("bread" in breadboard, "bean" in beanbag) as evidence, so with a brand that is also a fruit it read a single-board computer kit or a chair cover as groceries. Only the last part of a compound word counts now, the part that says what the thing is: a minivan is still a van.
