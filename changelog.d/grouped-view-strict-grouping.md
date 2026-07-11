---
type: fix
scope: dashboard
date: 2026-07-10
---
A pinned grouped view on the dashboard now groups strictly by its own group-by field. Before, a view grouped by a field that was empty on the items (like "Laser fleet by tube type" when no laser has a tube type set) fell back to showing each item's subtitle, which is a different field, so it displayed the wrong data under the wrong heading. Now an unset value is its own bucket, and when nothing carries the grouping field the card says so and points you at the fix instead of drawing a misleading breakdown.
