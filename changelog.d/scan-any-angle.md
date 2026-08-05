---
type: improvement
scope: scan
date: 2026-08-05
---
Barcodes now read at any angle. On a missed read the scanner measures which way the code is pointing from the stripe pattern itself and reads along that axis, replacing the earlier quarter-turn retry that only covered sideways codes. It also guards against a diagonal read of a long barcode masquerading as a valid short one, which briefly produced wrong scans; short codes now must repeat identically a few extra times before they count.
