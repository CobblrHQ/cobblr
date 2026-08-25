---
type: fix
scope: platform
date: 2026-08-25
---
Repeated failed logins against one account now trigger a short, growing lockout that is shared across all servers, so credential-stuffing from many addresses is throttled per account rather than only per IP.
