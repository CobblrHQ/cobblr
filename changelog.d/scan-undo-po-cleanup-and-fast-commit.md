---
type: fix
scope: scan
date: 2026-07-25
---
Sending a receipt's committed items back to the inbox now also removes their purchase-order line items and deletes the order once it is empty, so undo leaves no orphan order behind. Committing a big receipt is faster too: the item image is downloaded in the background instead of blocking the commit. "Send whole session back" now reverts the entire session even when it is larger than the recently committed list shows.
