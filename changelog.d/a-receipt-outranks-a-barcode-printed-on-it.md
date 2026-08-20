---
type: fix
scope: scan
date: 2026-08-19
---
A photographed receipt is read as a receipt even when a barcode from one of its own line items got attached to it. Reading the UPCs printed on a receipt is the camera doing its job on the wrong kind of paper, and the number then sent every re-run down the barcode lookup, so a Walmart receipt kept coming back as the pizza listed on it. Pressing re-run on a receipt that was filed wrongly now converts it into its line items.
