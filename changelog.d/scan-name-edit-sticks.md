---
type: fix
scope: scan
date: 2026-08-13
---
**Renaming a scan item in its own fields now sticks.** Open a scan inbox item, correct the name, and the card's title updates to match and the correction is saved. Before, that field only decided what the item would be called once you filed it: the title above kept showing the AI's name, and if you left without filing, your correction was thrown away. Every other place you can rename a scanned item already worked this way, so this one now matches. A name you have not touched is never written back, which also means an untouched barcode item can no longer publish a phantom correction to the shared barcode database.
