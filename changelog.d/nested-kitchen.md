---
type: fix
scope: bundles
date: 2026-08-23
---
Fixed a bundle creating a second copy of a place you already had, when yours was nested inside another one. A Kitchen kept inside Home was not recognised, so installing Groceries would add a new Kitchen at the top level rather than using the one you had. Places created inside a nested parent also sat at the wrong level in the tree.
