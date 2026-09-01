---
type: feature
scope: scan
date: 2026-09-01
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Opening a receipt now shows what it said it cost: subtotal, savings, tax, shipping and the total, beside the document they were read from. A marketplace seller shows on the item itself, next to the shop you bought from.

## docs

### What the receipt said it cost

Open the original receipt from a session and its money sits above the document:
subtotal, savings, tax, shipping, total.

Only what the receipt actually stated appears. A till slip with no tax line
shows no tax, because printing a zero there would be Cobblr's claim rather than
the shop's. A real zero is kept: tax-free is worth saying.

The parser has read these numbers since receipts shipped and no screen showed
them, so "what did this actually cost me" had no answer anywhere. Beside the
document is where the answer can be checked against the paper.

### Bought from, and sold by

A marketplace order has two parties: the shop you bought through, and the seller
who shipped it. Where the receipt names both, the item's own line says both -
"from eBay · sold by detroitaxle". Where there is only a shop, it says only the
shop.
