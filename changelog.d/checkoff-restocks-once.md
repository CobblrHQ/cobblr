---
type: fix
scope: lists
date: 2026-09-12
---
**Checking an item off the shopping list adds exactly what you bought, once, and the line says so first.** The Groceries, Spice Rack and Tea bundles declared their check-off wires twice, so one check-off added 2 and recorded two purchases, which doubled the learned re-buy rate on every shop. The line now reads "+1 to stock when checked" with a stepper to correct the amount before you check it, and the amount you settle on is what goes onto the record and into its purchase history. Existing workspaces heal on their own: the doubled wires are dropped at the next start, and the wire engine runs the same action on the same record once per event regardless.
