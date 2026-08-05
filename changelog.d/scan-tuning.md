---
type: improvement
scope: scan
date: 2026-08-05
---
Barcode scanning tries roughly twice as often as it used to. Measurements from a real phone showed two thirds of every decode cycle was deliberate idle, so the pause between attempts came down. The scanner URL also accepts scandelay, lens and zoom settings for trying alternatives on a real shelf, and the diagnostics readout reports which ones are active.
