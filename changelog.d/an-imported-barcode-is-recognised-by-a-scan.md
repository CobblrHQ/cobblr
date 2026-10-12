---
type: fix
date: 2026-10-12
scope: inventory
---
An Inventory CSV import keeps a Barcode column (or UPC, EAN, GTIN), so scanning an imported thing finds it straight away instead of looking it up as unknown. Export writes the barcode back out.
