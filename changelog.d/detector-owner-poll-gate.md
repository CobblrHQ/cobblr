---
type: feature
scope: digifab
date: 2026-07-07
---
When an external detector (like PrintGuard) **owns** a printer, Cobblr now fully stands down for that printer — per printer, so it works even inside a shared multi-printer connection (e.g. one printer of a Bambu farm moved to the detector). Cobblr stops its own AI watch and camera pull for it, won't send it jobs, and marks it *"watched by detector"* on the floor — so the printer's camera is only ever touched by the detector, with no double-load. Its telemetry (status/progress) keeps flowing, so you still see it.
