---
type: fix
scope: platform
date: 2026-08-07
---
Hourly background sweeps (maintenance due-soon, expiry, stock burn-rate) on instances with many workspaces no longer exhaust the database's connection slots: each sweep now closes a workspace's connection pool the moment it finishes with it, instead of quietly holding one pool per workspace until the next hour.
