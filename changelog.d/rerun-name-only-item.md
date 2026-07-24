---
type: fix
scope: core-scan
date: 2026-07-24
---
**Re-run AI now works on an item that has only a name (like a receipt line), not just barcode or photo items.** The button was enabled for these, but the server still refused with "item has neither a barcode nor a photo." Now a name-only item re-runs its name-based lookup, searching the web for a product image and re-routing it, so you can fill an empty photo or re-identify it.
