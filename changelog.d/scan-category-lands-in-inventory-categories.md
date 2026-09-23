---
type: fix
scope: inventory
date: 2026-09-22
---
A part filed from a scan now lands in Inventory's own categories, so the list's category filter finds it and the part form asks Category once instead of twice. The scan card shows the category and lets you change it before filing, and File all puts a batch under its agreed category. Workspaces that already had scanned parts are moved over on update: those values become categories in your tree, and a part you had categorised yourself keeps your choice.
