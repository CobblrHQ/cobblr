---
type: fix
scope: cadence
date: 2026-08-20
---
Fixed a case where an item that lives in its own table (Tea, Spices, Vehicles and any other skinned table) could end up with its shopping history split in two, so the "how often you re-buy" figure was learned from only part of it. Purchases recorded by a scan were filed under a different name for the same item than purchases recorded by checking it off a shopping list. Existing workspaces are repaired automatically on the next start; nothing to do.
