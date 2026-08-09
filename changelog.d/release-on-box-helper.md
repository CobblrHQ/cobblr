---
type: fix
scope: platform
date: 2026-08-09
---
The automated nightly release works when it runs on the deploy box itself. Every script that needed the box reached it in a way that only worked from a developer's machine, so the scheduled release refused to run.
