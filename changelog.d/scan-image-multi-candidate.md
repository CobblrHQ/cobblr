---
type: fix
scope: core-scan
date: 2026-07-24
---
**More scan items get a photo automatically.** When the auto image search found a product picture, it saved just the top link and hoped your browser could load it. Many product pages block that (hotlinking) or the link is dead, so the tile showed empty. Now it downloads the image into your workspace and, if the best one can't be fetched, tries the next few results until one sticks, so far more items land with a real photo.
