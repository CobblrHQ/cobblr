---
type: fix
scope: scan
date: 2026-08-05
---
Sideways barcodes now scan. A code held with its bars running vertically never read at all, no matter the lighting or distance, because the rotated retry was handing the decoder a corrupted image. The scanner now turns the frame itself and reads either orientation.
