---
type: fix
scope: scan
date: 2026-09-23
---
A scanned phone no longer lands in Groceries because of the shop that sells it. The router read every word a barcode catalog returned, including the names and links of the stores listing the product, so a phone whose seller's name ends in "egg" matched the grocery word, and with a fruit for a brand name it went to Groceries without asking. Store names and links no longer count as evidence about what a thing is; the listing's own title still does.
