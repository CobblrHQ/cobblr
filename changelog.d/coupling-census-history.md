---
type: internal
scope: tooling
date: 2026-08-16
---
The module-coupling census now records its readings to a history repo
(CobblrHQ/coupling-census) instead of printing them into a job log that nobody
assembles into a series, and it is dispatched by the daily release against the
commit that release ships rather than running on its own cron against main.
