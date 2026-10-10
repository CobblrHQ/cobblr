---
type: feature
scope: builds
date: 2026-10-06
docs_target: docs/modules/electronics-assembly.md#Pick and place
docs_published: 2026-10-10
---
Added calibrated pick-and-place exports, feeder QR checks and authorized station recording with placed-board stock.

## docs

Prepare an assembly work order with a verified machine calibration and exact feeder map, download its OpenPnP or vendor import files, and load them on the machine. At its authorized browser station, scan every reel at its slot and confirm Start and Done. The final side draws the reserved kit including attrition and adds placed-board stock once. OpenPnP event scripts can report the same steps when its scripting engine is available.
