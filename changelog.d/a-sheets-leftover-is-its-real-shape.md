---
type: improvement
scope: inventory
date: 2026-10-08
docs_target: none (documented directly in USER_GUIDE.md Sheet stock and docs/modules/inventory.md)
---
A sheet's leftover now keeps its real shape. A triangle cut across a sheet leaves a triangle offcut that reads about half the sheet, where it read nothing left before, and the sheet drawing shows it as a triangle. Laser nesting places parts into that leftover, and the slivers between nested parts still never count.
