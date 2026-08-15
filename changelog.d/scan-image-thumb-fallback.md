---
type: fix
scope: scan
date: 2026-08-14
---
Picking a catalog photo you can see no longer fails with "that image couldn't be used". Many sites serve the small preview happily and block the full-size original, so when the original cannot be fetched the picture actually on screen is used instead. The full-screen viewer does the same rather than showing an empty frame.
