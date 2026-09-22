---
type: improvement
date: 2026-09-22
---
Your database dump now runs at an hour you choose (`BACKUP_AT`, default 03:00 local) instead of "24 hours after the backup container last started", so the time no longer moves every time you update. A finished dump also writes `data/backups/last-dump`, so a job that copies the dumps off the machine can run after today's dump instead of guessing.
