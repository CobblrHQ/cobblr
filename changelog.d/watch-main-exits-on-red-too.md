---
type: internal
scope: ci
date: 2026-10-09
---
`scripts/watch-main.sh` waits for main's whole-suite verdict and exits once on green or red, naming the first failing test, so a watcher can no longer sit silent on a red main overnight.
