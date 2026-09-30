---
type: selfhost
scope: deploy
date: 2026-09-29
---
**The database container gets room for its shared memory.** Every compose file now gives Postgres 1 GB of `/dev/shm` instead of Docker's 64 MB. A server holding many workspaces used to run out, and new workspaces then failed to be created. The new size takes effect when the db container is recreated (`docker compose up -d db`), which restarts the database, so pick a quiet moment.
