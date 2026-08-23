---
type: fix
scope: groceries
date: 2026-08-23
---
Fixed "must be kept" being worked out for scanned food and then not shown anywhere. The value was recorded and used, but there was no field for it, so you could not see what Cobblr had decided or correct it. It now appears on the item with the three choices, and anything you pick is used instead of the guess. That was already how it behaved; there was simply no way to exercise it.
