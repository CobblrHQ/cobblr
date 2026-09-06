---
type: fix
scope: scan
date: 2026-09-06
---
A receipt line that matches something you already have is recognised again,
including when that thing lives in Groceries, Tea or Spices. The check was only
looking at the plain tables, so nothing on a grocery receipt was ever flagged,
one product became two rows, and filing never added to the one you had. The
card now also shows the picture you already chose for that record rather than
searching the web for a new one.
