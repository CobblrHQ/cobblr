---
type: feature
scope: locations
date: 2026-07-10
docs_target: none (documented in USER_GUIDE.md in this commit; no release-timed doc surface exists yet)
---
**Per-layout snap grid: 42 mm = exact Gridfinity.** Every layout now has its own snap pitch (edit mode, "grid"): a drawer set to 42 mm quantizes bin positions and sizes to true Gridfinity cells, the edit dots show the real pitch, and the panel reads sizes in grid units ("3 × 2 u"). The garage keeps its coarse default.

## docs

Every layout has a snap pitch, editable in edit mode: the garage keeps the 100 mm default, but a toolbox drawer can be set to 42 mm for exact Gridfinity (or whatever "one square" means to you). Positions and sizes quantize to it, the edit-mode dots show the real cells, and the panel reads out sizes in grid units next to the mm.
