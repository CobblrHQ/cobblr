---
type: fix
scope: core-views
date: 2026-10-10
---
**A view with a grouping it cannot use still opens.** A workspace that installed Lego before 0.6.5 kept a "By part category" view grouped by a field the bricks do not have, and it opened onto an error. Now it shows your bricks in one list and says which grouping it skipped; editing the view or updating the bundle brings the groups back.
