---
type: improvement
scope: ci
date: 2026-10-18
docs_target: none (contributor-facing merge machinery, documented in docs/operations/ci/merging.md "A freeze holds only what touches its files")
---
While main waits on one pull request's re-check, other pull requests that change none of its files now merge instead of waiting with it.
