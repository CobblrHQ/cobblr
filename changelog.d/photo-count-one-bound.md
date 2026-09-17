---
type: fix
scope: scan
date: 2026-09-17
---
**A count read off a photo is bounded the same way on every path.** When the identify step says how many of a thing it sees, that number was capped at 999 on one path and not at all on two others, so a label read as a count (a capacity, a weight) could seed a record with thousands. Every path now reads one rule: at least one, at most 999; you can still set more yourself.
