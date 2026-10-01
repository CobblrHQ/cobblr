---
type: fix
date: 2026-09-29
---
Wires set to run when a record is created, updated or deleted now run. Before, they were saved but never fired. Where a kind of record does not report one of those moments, the wire editor now greys that choice out instead of saving a wire that would never run, and an existing one says so on the Wires page.
