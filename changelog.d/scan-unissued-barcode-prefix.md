---
type: fix
scope: scan
date: 2026-08-15
---
A barcode read at an awkward angle can decode as a different code whose check digit is valid, so the checksum cannot catch it. The scanner now also asks whether the code claims a manufacturer prefix that has ever been issued, and makes a code claiming an unissued one prove itself over more frames before it counts. Genuine barcodes are unaffected.
