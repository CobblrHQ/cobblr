---
type: fix
scope: scan
date: 2026-07-04
---
The scan matchmaker no longer offers to install a bundle whose table **name collides with one you already have**. Previously, if your workspace had a "Bookshelf", the menu could still surface a community "Bookshelf" bundle right beside it — two chips you couldn't tell apart, and confirming the wrong one would create a duplicate same-named table. Now a not-yet-installed bundle entry is dropped when its display name matches a live table's, so you file into the table you actually have.
