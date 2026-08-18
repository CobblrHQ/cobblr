---
type: fix
date: 2026-08-18
---

Asking Cobb to set a value it cannot actually change now says so, instead of
reporting success. Some fields are maintained by Cobblr itself, like the order
of locations in your tree, and until now those looked settable: the change
appeared to save, the record showed a fresh edit time, and nothing had moved.
Those fields are marked read-only now, Cobb no longer offers to set them, and
the record's own history shows what you asked rather than the instructions Cobb
was given.
