---
type: feature
scope: scan
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Point the camera scanner at a paper receipt and it is read as a receipt: one inbox line per item, under its own "Receipt" session, with the purchase recorded. Before this it was filed as a single thing you owned, named after whatever text the camera could read off the paper.

## docs

Photographing a receipt now does the obvious thing. The scanner sends the picture to the same reader that a PDF or an emailed receipt goes to, so you get one inbox line per item under a "Receipt · <store>" session, and the purchase itself is recorded, rather than one item named after whatever was legible on the paper.

Nothing new to press. The pass that normally identifies a product reports when it is looking at a receipt instead, and the picture is kept as the session's original, so "View original" and "Re-parse" work exactly as they do for an uploaded one.

It is deliberately hard to trigger by accident: a photo that WAS identified as a product is never treated as a receipt, however much its packaging mentions invoices, and a dark or unreadable frame is treated as a bad photo rather than a receipt. If a receipt is recognised but its lines cannot be read, the photo stays in your inbox with a note saying so, so nothing is lost.
