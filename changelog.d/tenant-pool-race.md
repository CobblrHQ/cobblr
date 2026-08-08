---
type: fix
scope: platform
date: 2026-08-08
---
**A background job can no longer make a request fail by closing a database connection out from under it.** Cobblr keeps one connection pool per workspace and lets background sweeps close pools they are finished with, so a job that visits every workspace does not hold hundreds of connections open. The check for "is anyone still using this?" could not see a request that had just been handed the pool but had not yet run its first query, so a sweep could occasionally close it underneath and the request would fail with an internal error. The check is now correct, and as a second line of defence a request whose pool disappears quietly reconnects instead of failing.
