---
type: fix
date: 2026-10-12
scope: core
---
A page that fails to load on a patchy connection tries again on its own, then says "Couldn't load this page" with a Retry button, instead of staying blank. A page left open across an update gets the new version the same way.
