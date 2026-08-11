---
type: fix
date: 2026-08-11
scope: fields
---

Inventory tables showed a raw internal id for fields that point at a person or another record, while the same field read correctly everywhere else. The module's own list was a second way of reading the same records that skipped the step which turns ids into names.
