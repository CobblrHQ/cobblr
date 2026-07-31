---
type: fix
scope: backup
date: 2026-07-31
---
Fixed backups still piling up in Google Drive: a large backlog made the cleanup take so long the run was lost before it finished, so retention never took effect. Cleanup now runs in parallel and no longer blocks recording the backup, so Drive is trimmed to your retention count reliably.
