---
type: fix
scope: labels
date: 2026-07-24
---
**Labels fill their height and print the cut line.** The caption now hugs the top and the QR fills the space beneath it, so a bigger name shrinks the QR instead of pushing it off the bottom edge, and there is no dead whitespace up top. Both the on-screen preview and the Bluetooth print do this the same way, and both cap the name to the same line count so what you see is what prints. Tiled 2-up rolls now print a solid cut line between the two labels (it was being skipped whenever the printer had not stored a media feed type).
