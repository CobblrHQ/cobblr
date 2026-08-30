---
type: fix
scope: scan
date: 2026-08-30
---
Adding a photo to a barcode scan no longer drops you into a different card afterwards: the shot attaches, the drawer shows it landed, and the next barcode is a new item. If you had already moved on to the next scan by the time the photo uploaded, nothing from the previous item surfaces over it. The photo strip's + works the moment a barcode is read instead of waiting out the lookup, and the scanner stays quiet while you frame that shot so the label's barcode cannot become a second item.
