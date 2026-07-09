---
type: feature
scope: devx
date: 2026-07-09
docs_target: none (contributor tooling — the pipeline itself has no end-user surface)
---
**Docs now ship with the feature, and publish with the release.** Every feature changeset carries its user documentation (`## docs` + `docs_target:`), written in the same PR while the change is fresh — enforced at the merge gate. `scripts/docs-flush.mjs` publishes each blurb into its target doc only once the feature is actually live, so public docs never describe something that hasn't shipped and release-day docs work is zero.
