---
type: fix
scope: platform
date: 2026-08-25
---
**A new workspace's database no longer accepts a connection from anyone but its own user.** Postgres grants the right to connect to every role by default, so database-per-tenant isolation leaned on the password alone. New tenant databases now grant their own user an explicit connect right and then remove the default one, so nothing else on the cluster can even open a connection to that database. Existing workspaces are unchanged (no principal holds another workspace's database password, so none could cross-connect regardless).
