---
type: fix
scope: labels
date: 2026-07-24
---
**Bluetooth prints now match the on-screen preview.** The thermal renderer was a separate, cruder path: it put the QR on top with a single unwrapped line of text below, drew no center code, and ran edge-to-edge so wide media clipped. It now lays each label out the same way the preview does, by shape, name on top (wrapped) with the QR below for tall and square labels, QR-left/name-right for wide ones, draws the short code in the QR center, and leaves a whitespace margin so nothing prints off the edge. Tiled 2-up media also prints a solid cut line between the labels. A cross-package test pins the thermal layout to the same rule the preview uses, so the two can't drift again.
