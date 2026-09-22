---
type: fix
scope: views
date: 2026-09-22
---
A saved view that groups by one of a bundle's own fields (Yarn's By weight, Warranties' By category, any view you group by a custom field) groups by it again, instead of showing a single "(none)" section over every row. Yesterday's fix for grouping by location had narrowed the reading to the module's native columns.
