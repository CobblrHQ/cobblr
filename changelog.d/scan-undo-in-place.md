---
type: fix
scope: scan
date: 2026-07-16
---
Undoing an accidental discard no longer jumps the item (and its whole session) to the top of the inbox: a restore now puts things back exactly where they were, with a brief highlight so a later restore from Recently deleted is still easy to spot. Also, book covers scan reliably on older Safari too (the fallback decoder now handles two-barcode covers like the main reader).
