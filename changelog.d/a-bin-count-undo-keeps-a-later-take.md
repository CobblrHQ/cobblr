---
type: fix
scope: core-scan
date: 2026-11-09
---

Undo after changing a count at a bin no longer takes away a change someone else made since: it puts the count back only if nothing changed, and otherwise says what did.
