---
type: improvement
date: 2026-06-25
---

- Sync sections can filter source rows by a field, so one endpoint feeds several sections: e.g. companion app /printers returns printers + lasers + CNC, and "filter": { "from": "$.category", "equals": "printer" } imports only the 3D printers. Each category into its own section/instance.
