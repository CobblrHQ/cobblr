---
type: fix
date: 2026-07-20
---

Contributor docs now say pnpm, which is what the repo actually uses. A new CI check also catches a workspace package that cannot be typechecked without being built first, which is what kept the label-printing work red for days.
