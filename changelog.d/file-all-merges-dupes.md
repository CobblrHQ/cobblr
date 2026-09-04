---
type: fix
scope: scan
date: 2026-09-04
---
Filing a batch no longer creates a second record for something you already
have. A scan that matches an existing item is added to it as more of the same,
which is what the card has always done and what the bulk File all quietly
skipped, so one product could end up as two rows differing only in word order.
The button says how many will join what you already have before you press it.
