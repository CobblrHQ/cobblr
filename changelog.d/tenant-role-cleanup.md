---
type: fix
scope: platform
date: 2026-08-07
---
Deleting a workspace now removes its database user as well as its database. Postgres users are cluster-wide, so they were left behind on every delete, and instances that reap expired trials accumulated one per reaped workspace forever. Existing leftovers are swept automatically on the next start.
