---
type: fix
scope: scan
date: 2026-09-01
---
Walking the scanner and the inbox end to end on a real deployment found six things and fixed them. After adding a photo to a barcode scan, the camera no longer re-reads the same label a moment later and replaces your review with a fresh "Looking up" for the code you just handled. The session theme suggestion works again; its request had been rejected on every inbox load. Opening a receipt's original now shows what it cost, which was wired to a field real receipts never carried. On a phone the dashboard's install suggestions wrap instead of running off the edge. And a photo that nothing could read because the workspace has no AI yet says so, with a link to set it up, instead of claiming it tried. And on a phone a card's destination pill no longer squeezes its table name down to one letter beside a bundle suggestion; the suggestion takes the next line.
