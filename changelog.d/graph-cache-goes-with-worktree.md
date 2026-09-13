---
type: internal
scope: tooling
date: 2026-09-13
---
**The graph database goes with the worktree.** `worktree-autoclean.sh` deletes the codebase-memory index of a reaped worktree and of any directory that no longer exists; a live one is never touched. 1,598 dead indexes (159.5 GB) had piled up on one machine.
