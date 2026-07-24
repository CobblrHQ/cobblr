---
type: fix
scope: scan
date: 2026-07-24
---
Scanning a product whose box carries both a barcode and a generic marketing QR (a Nike shoebox's `qr.nike.com` link next to the UPC) now reads the barcode. The camera used to grab the QR link every time and ignore the UPC. Cobblr's own QR labels still take priority as before; only anonymous web links are held back so the product code beside them can win.
