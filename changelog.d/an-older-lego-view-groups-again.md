---
type: fix
scope: core-views
date: 2026-10-10
---
**Lego's "By part category" groups your bricks again, without an update.** A workspace that installed Lego before 0.6.5 kept a view grouped by a field the bricks do not have. Cobblr now gives that view the current bundle's grouping when it starts, as long as you never changed the view yourself; a view you edited stays as you left it.
