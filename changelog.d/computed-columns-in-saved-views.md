---
type: fix
scope: inventory
date: 2026-08-20
---
Fixed calculated columns never appearing on a table, even when a saved view asked for them by name. The Spice Rack and Tea tables ship a "How often you re-buy" view whose two columns are both calculated, and it rendered with no columns at all. Calculated fields still stay out of a table's default columns; a view that names one now gets it.
