---
type: feature
scope: scan
date: 2026-09-01
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The picture you pick for something off a receipt is remembered and re-served, so the next scan of the same shop's product gets it instead of another web guess. Choosing a better photo for a barcoded item has always fed back that way; a receipt line has no barcode, so the shop plus the line's name is its identity now. Only pictures from the web are shared - a photo you took yourself stays in your workspace.

## docs

### The picture you choose is remembered

Pick a better catalog photo for something and Cobblr keeps it. The next scan of
the same product gets your picture rather than starting another web search.

For a barcoded item this has always worked through the shared product database:
your corrected image becomes the answer for that barcode everywhere.

A receipt line has no barcode. A till slip says "Baby Carrots" and nothing more,
so the search started fresh every time and could keep serving a tin of peas and
carrots for fresh produce. The shop and the line's name are the identity such an
item does have, so a picture you pick for "Lidl / Baby Carrots" is remembered
under that pair, and re-served the next time anyone scans it.

Two limits, both deliberate:

- **Only pictures from the web are shared.** A photo you took yourself stays in
  your own workspace. It is your picture, and it would not be readable anywhere
  else anyway.
- **A shop's line is its own product.** "Baby Carrots" from one supermarket does
  not answer for another's, so the shop is part of the key. An item with no shop
  recorded is not remembered at all, rather than binding one shop's picture to
  everybody's product of that name.

A later pick replaces an earlier one, so a wrong picture is corrected by choosing
a better one.
