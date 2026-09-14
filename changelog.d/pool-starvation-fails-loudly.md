---
type: fix
scope: platform
date: 2026-09-15
---
**The api no longer hangs in silence when it runs out of database connections.** A request that cannot get a connection within ten seconds now fails with a clear error instead of waiting forever, the health endpoint reports each connection pool's numbers, the log says when connections are starving, and the hourly maintenance jobs stop holding a request's connection for the length of their run.
