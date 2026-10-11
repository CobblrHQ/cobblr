---
type: internal
date: 2026-10-11
---

The pre-push hook runs only the lints a change can reach, and CI keys every lint by a handful of git object ids instead of replaying what it read.
