---
type: fix
scope: cadence
date: 2026-08-20
---
Fixed the "how often you re-buy" figure being roughly halved when something was recorded twice on the same day, which happens routinely: scanning an item files a purchase, and checking it off the shopping list files another a few minutes later. Two entries hours apart were being read as a genuine gap between shopping trips. Things bought weekly were reading as every four days.
