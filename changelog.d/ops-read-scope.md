---
type: selfhost
scope: auth
date: 2026-08-12
---
API tokens gain an `ops:read` scope: read-only access to the operator overview and product metrics, and nothing else. It exists for a monitoring or reporting tool that should be able to see the dashboards without being able to read tenant data or write anything.
