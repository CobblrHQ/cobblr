---
type: fix
scope: ai
date: 2026-08-20
---
Undoing a batch no longer removes a container holding something it just decided to keep. A place that still has things in it is left alone and says which ones, because deleting it would take them along: locations remove their contents when they go, so an undo that spared the shelf you had edited and then removed its rack had deleted your shelf anyway, one step later and without saying so.
