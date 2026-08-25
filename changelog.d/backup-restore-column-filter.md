---
type: fix
scope: platform
date: 2026-08-25
---
Restoring a workspace backup now checks every column name in the uploaded archive against the real table before loading it, so a tampered backup file cannot smuggle unexpected identifiers into the restore.
