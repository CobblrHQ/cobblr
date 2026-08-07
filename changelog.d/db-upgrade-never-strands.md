---
type: improvement
scope: platform
date: 2026-08-07
---
An automatic update can no longer leave an instance with a database that will not start. The database image now upgrades clusters left at the pre-18 mount layout in place (no compose edit needed), and when a major upgrade cannot proceed safely it keeps serving the previous Postgres version from the untouched data and alerts the admin (log plus superadmin email) instead of failing. Operators who want to schedule major upgrades themselves can set COBBLR_DB_MAJOR_UPGRADE=hold.
