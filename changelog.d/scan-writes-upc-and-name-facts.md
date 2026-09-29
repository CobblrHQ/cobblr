---
type: improvement
scope: scan
date: 2026-09-29
docs_target: none (documented directly in docs/modules/core-scan.md "What the scan knows reaches the record and its type")
---
Scanning a product now fills its barcode into the record's UPC and the plain facts in its name (like 1.75 mm or 1 kg) into matching fields. A scanned filament spool's type gets its UPC, so the next scan of the same box finds it. Spools filed before this get the same, plus the temperatures, density and empty spool weight their tag carries.
