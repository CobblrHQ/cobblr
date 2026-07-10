---
type: improvement
scope: platform
date: 2026-07-02
---
Three operational safety nets for self-hosters. **Downgrade detection**: booting an older image against a newer database now logs a loud, named warning instead of silently half-working. **Restore preflight**: send a backup with `dry_run=true` and get a full report of what a restore would do: rows, tables, files, whether existing data would be replaced, with nothing changed. **Audit-log retention**: an optional `ACTIVITY_LOG_RETENTION_DAYS` bounds the activity log on public hosts (unset = keep everything, as before).
