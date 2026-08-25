---
type: fix
scope: platform
date: 2026-08-25
---
Fixed a case where batched notification digests could arrive late on busy hosted instances. The periodic delivery sweep held onto a coordination lock it meant to release, so following sweeps skipped until the stray lock timed out. Acquire and release now run on the same database connection, so the lock is always freed on time.
