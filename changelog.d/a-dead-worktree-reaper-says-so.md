---
type: internal
scope: platform
date: 2026-09-22
---
**A worktree reaper that has stopped working now says so.** The cleanup that removes merged, finished working copies read its planner's answer with every error thrown away, so when the planner broke on one kind of machine it removed nothing, reported nothing, and let finished copies pile up until the disk was nearly full. It now stops and reports the planner's own error when the planner fails, records the outcome of each run, and the start of every session names a cleanup that failed last time or has not run for two days.
