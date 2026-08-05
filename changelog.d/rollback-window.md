---
type: feature
scope: operations
date: 2026-08-05
docs_target: none (operator-facing; documented in docs/operations/PRODUCTION_DEPLOY.md)
---
Rolling back to the previous release is now a supported, tested path: migrations are enforced additive, so the older image runs on the newer schema, and a nightly job proves it by booting yesterday's build against today's database.
