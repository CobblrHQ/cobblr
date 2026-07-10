---
type: improvement
scope: digifab
date: 2026-07-03
---
**The library reads your slicer's mind.** Uploading a plate file now parses the slicer's own comment headers (estimated time, material, layer height, filament grams) plus the `4x Name_…_PLA_…_1h30m` filename convention (which is what carries parts-per-plate). Library cards show material / time / parts-per-plate chips, and picking a file in a **production run** pre-fills parts-per-plate and shows the per-plate estimate. No more counting parts off the plate preview.
