---
type: selfhost
date: 2026-09-09
---
Background sweeps (bundle updates, notifications, reminders and the rest) now share one pool budget across the whole process, so an instance with hundreds of workspaces no longer runs Postgres out of connections every hour. The cap is eight workspaces at a time, adjustable with `COBBLR_SWEEP_POOL_CONCURRENCY`.
