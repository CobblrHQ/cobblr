---
type: improvement
scope: platform
date: 2026-11-06
---

An update across a module migration no longer runs a many-workspace server out of connections: the catch-up keeps to the api's share of the database, and health keeps answering while it runs.
