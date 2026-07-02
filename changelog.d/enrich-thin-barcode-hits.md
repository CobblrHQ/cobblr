---
type: feature
date: 2026-06-23
---
When a barcode resolves to a thin entry (a bare category like "Bourbon" from a crowdsourced food-facts mirror, missing the brand), the scan now uses web + AI to build the full product title ("Bulleit Bourbon Frontier Whiskey 750mL") and writes the richer result back to the shared Barcode Intelligence DB — so it supersedes the thin entry for every future scan. External databases are a starting point; we enrich our own on first encounter.
