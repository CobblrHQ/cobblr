---
type: fix
scope: scan
date: 2026-08-31
---
The scanner now leans in when it can see something and cannot read it, instead of zooming away from it. A small barcode on a busy label used to defeat the automatic zoom entirely: the size estimate reported the whole scene rather than the code, so the camera concluded the barcode was too big and backed off, making it smaller still.
