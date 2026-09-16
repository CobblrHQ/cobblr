---
type: fix
scope: scan
date: 2026-09-16
docs_target: none (the guide already promises it: "Looks fine dismisses a flag once a human has eyeballed it")
---
**"Looks fine" now clears the short-barcode warning everywhere.** Tapping Looks fine on an item scanned from a short (8-digit) barcode left the amber "double-check this is the right product" on the row, on the item screen and on the desktop card, with nothing left to dismiss it. The warning is now part of the item's state and goes away the moment you say it looks fine, on every surface; the "Identified via…" provenance stays readable in the Source data box.
