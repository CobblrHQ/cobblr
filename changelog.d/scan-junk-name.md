---
type: fix
date: 2026-06-24
---
A barcode that can't be identified anywhere no longer shows a junk result: the web-search fallback used to accept an "Unknown Item" / "XXXXXXXX" placeholder as the name (and then image-search it). Those are now rejected: the item is left unnamed for a photo or manual entry, with no bogus name or photo.
