---
type: feature
date: 2026-09-04
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
A personal AI key routed into a workspace is now configurable in that workspace, the same as a key the workspace owns. Under Configuration, AI, each job (Ask Cobb, Identify a scanned item, Pick the best product photo, and the rest) can be pointed at any connection routed here, not only at the workspace's own providers, so chat can run on one provider while scanning runs on another. Before this, a routed key quietly served every job and the per-job settings on that page did nothing at all while it was in play.

## docs

Under Configuration, AI, every job has its own setting: Ask Cobb, Identify a scanned item, Sort a photo into categories, Pick the best product photo, and the rest. Each one can be pointed at either a provider this workspace installed or a personal connection somebody routed here and the owner accepted, so chat can run on one provider while photo identification runs on another. Pick a model too where the provider offers a choice; leave it alone and the provider's own default for that job is used. A job with no setting runs on whatever the workspace would otherwise use.
