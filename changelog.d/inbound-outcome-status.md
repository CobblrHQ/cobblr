---
type: internal
scope: scan
date: 2026-08-13
---
The inbound-email dispatcher records an outcome for each message: imported, duplicate, degraded, or nothing to import. The reprocess work-list reads that instead of working it out from an item count, so it lists only messages a replay could still help.
