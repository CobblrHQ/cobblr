---
type: fix
scope: self-hosting
date: 2026-09-26
---
**Updating to the current compose file keeps your database.** If your instance took the automatic Postgres 17 to 18 upgrade on the older compose file and you then switched to the current one, the database could come back from its pre-upgrade copy, losing everything written since. It now keeps serving the upgraded database it already has.
