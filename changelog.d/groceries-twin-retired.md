---
type: selfhost
date: 2026-09-13
---
**Groceries fields now live on the Groceries table only.** An early install also put a copy of them on plain Inventory, which made every inventory table look perishable. On the next start, food that was still filed in plain Inventory moves into Groceries (each move noted in the workspace's activity log as moved by the upgrade) and the copy is removed. Nothing else changes; a plain part with none of the food fields stays where it is.
