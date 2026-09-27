---
type: feature
scope: core-scan
date: 2026-09-27
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: none (the card's existing doubt line renders the row's note; the name is written server-side)
---
A product without a barcode is now known to the next person who photographs it. When you file something the AI named from a photo, the product words on its label that are also in what you filed go to Cobblr's shared barcode network, so the next photo of that product gets the name you settled on.

## docs

**Products without a barcode are learned too.** When you photograph a product
that has no barcode and file it, the words on its label that are also in the
product you filed (its brand, product name, colour or size) join Cobblr's
shared barcode network, with the name you settled on. The next person to
photograph that product gets the same name. Until someone else agrees, the card
says "Named by one person on the barcode network. Check it, or correct it."
Only those product words are shared, never the photo or any other text on it.
