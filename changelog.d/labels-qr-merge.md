---
type: improvement
scope: labels
date: 2026-07-18
---
QR scan codes and label printing are one module now. The former core-labels-qr module folded into Labels (0.6.0): same tokens, same printed codes, same scan behavior, one place to find it all. Workspaces that used QR keep everything (converted automatically, wires included); workspaces that never minted a code keep their blank slate, and enabling Labels brings the whole feature back.
