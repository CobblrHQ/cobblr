---
type: improvement
scope: scan
date: 2026-07-29
---
"Pick best (AI)" now uses what the scan already knows about the item. If it's clothing, the AI is told to pick the garment alone with no person and the right colour; if it's a food or boxed product, it knows the front of the package is the correct photo instead of rejecting it as clutter. The heuristic also hands the AI a tidier shortlist now, dropping obvious junk and duplicates first, so the AI is choosing between good options rather than rescuing a bad strip.
