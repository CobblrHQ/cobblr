---
type: fix
scope: platform
date: 2026-09-24
---
**Quick edits to several fields of one item all save.** Changing a few custom fields in a row (a value, where you bought it, when) could keep only the last one after a reload, with no error shown. Each edit now saves only the field it changed, merged into the record as it stands, on every kind of record: items, assets, records, machines, projects, orders, lists and locations. Clearing a field removes just that field.
