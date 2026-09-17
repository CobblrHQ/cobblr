---
type: internal
scope: ci
date: 2026-09-17
---
Every test job now posts what it covered as a commit status (`suite / affected`, `suite / full`), the tracker carries the branch's full-suite verdict onto commits that had nothing to test, and `merge-pr.sh` refuses to merge onto a main whose full suite is red. "Main is green" is a statement about the branch, not about the last commit's subset.
