---
type: selfhost
scope: api
date: 2026-10-07
---
Requests refused by the built-in rate limit are now logged (the rule and route, never the visitor's address) and counted on `/api/v1/healthz` under `rate_limited`, so an operator can see whether anyone was turned away.
