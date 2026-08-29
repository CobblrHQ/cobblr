---
type: fix
scope: platform
date: 2026-08-29
---
Backups now actually contain your uploaded files. They were being skipped entirely because the backup looked for a table under the wrong name, so a restore came back looking complete with every photo missing.
