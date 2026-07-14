---
type: fix
scope: core-scan
date: 2026-07-14
---
**The inbox stopped offering to merge two products that just happen to be the same brand and colour.** It was suggesting you combine a Leviton wall plate with a Leviton rocker switch, because the two names share the words "decora" and "white". Half of Leviton's catalog shares those words. Meanwhile both items had been resolved from their own barcodes, which said plainly that they were different products, and the suggestion ignored that. Barcodes now decide first: two items with the same scanned barcode are the same thing, two with different barcodes are not, and the one honest exception (a ten-pack of the very same unit carries its own barcode) is recognised from the pack size rather than from word overlap. Items identified from a photo with no barcode still fall back to comparing names, as before.
