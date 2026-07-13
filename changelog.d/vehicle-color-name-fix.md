---
type: fix
scope: core-scan
date: 2026-07-13
---

**Vehicle scans now name the body style and reliably fill the color.** A scanned
VIN mints a fuller name ("2019 Honda Civic **Hatchback EX**", adding body + trim),
and the paint-code color now resolves even when the label read just lists the
codes without labeling one "color": it matches each code against the paint table,
so the real one wins (a Honda "NH830M" among "TGG K LJ5" becomes "Lunar Silver
Metallic"). The catalog photo search also folds in the resolved color, so the
suggested picture matches the actual car.
