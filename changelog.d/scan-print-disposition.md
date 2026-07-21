---
type: feature
scope: scan
date: 2026-07-21
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The Scan page has a new Print mode: scan an item's QR label and its label goes straight to the print buffer instead of opening the item, so you can reprint a run of labels as you walk the shelves.

## docs

**Scan mode: Open or Print.** When you turn on "Drive this screen with scans" on
the Scan page, a small selector appears next to it with two modes:

- **Open** (the default): scanning a Cobblr QR label opens that item, bin, or
  machine, the same as before.
- **Print**: scanning a QR label drops *that item's* label into your print
  buffer instead of opening it. Nothing navigates. Combined with an auto-print
  policy (a printer, a label size, and a fire rule like "every 2" or "when the
  sheet is full"), a walk down the shelves scanning bins queues a run of labels
  and prints them automatically once a sheet fills.

The mode is remembered per workspace, so the Scan page comes back the way you
left it. Product barcodes (a UPC on a box, not a Cobblr label) still go to the
scan inbox in either mode, since a raw product has no item to print a label for
until you confirm it. Print mode queues on the server, so it also works when the
scan comes from a phone or an edge bridge rather than the screen in front of you.
