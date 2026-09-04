---
type: internal
scope: tooling
date: 2026-09-04
---
The scripts agents already run now print which commit each channel is on. `merge-pr.sh` says it after every merge and `new-worktree.sh` when a task starts, so nobody works from a stale idea of what the nightly is or tells a self-hoster their fix is available before it has been cut.
