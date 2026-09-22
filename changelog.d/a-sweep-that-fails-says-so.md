---
type: selfhost
scope: operations
date: 2026-09-22
---

`/api/v1/healthz` now reports `sweeps_failing`: the hourly cross-workspace
passes (expiry reminders, arrivals, maintenance) whose last round failed for
a workspace, with the first few named and why. A pass that failed every hour
used to be a counter nothing read. `scripts/deploy-gap.sh` says it on its
health line. And a workspace whose expiry ledger table is missing (its lists
migration has not run) is skipped and named there rather than sent the
reminder every hour.
