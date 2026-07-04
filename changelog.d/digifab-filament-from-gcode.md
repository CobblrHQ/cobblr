---
type: feature
scope: digifab
date: 2026-07-04
---
The New-job form now reads the **filament material and grams straight from the gcode/3MF** you pick, instead of asking you to retype what the slicer already computed. Pick a printable file and Cobblr parses its slicer metadata (PrusaSlicer / SuperSlicer / OrcaSlicer / Bambu comment headers, plus 3MF `slice_info`), pre-fills the grams, and matches a spool by material (PLA → your "PolyTerra PLA" spool) — all still editable. On completion the grams deduct from that spool as before. Multi-extruder prints sum correctly, and the material type is recorded on the job even when no spool is matched.
