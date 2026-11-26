---
type: fix
scope: platform
date: 2026-11-26
---

After a power cut, the api waits for its database to finish crash recovery however long it takes, instead of giving up after ten minutes and restarting into the same wait.
