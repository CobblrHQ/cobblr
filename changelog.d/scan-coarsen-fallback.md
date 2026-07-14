---
type: fix
scope: core-scan
date: 2026-07-14
---
**Scanned items of the same kind land together, even in a workspace that uses several tables.** Two fixes to how the scanner files things. First, the category it assigns is now the broad, everyday kind you'd actually file something under, rather than the hyper-specific label a product database returns. Those databases split one kind into dozens of narrow sub-types, which is too fine to group by. Second, when a workspace has several named tables and its generic default table is hidden, the scanner previously had no catch-all, so anything it couldn't place confidently scattered across the named tables. There is now always a catch-all (the default table, told apart by category), and it reappears the moment something lands in it.
