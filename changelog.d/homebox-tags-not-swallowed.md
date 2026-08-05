---
type: fix
scope: import
date: 2026-08-05
---
Homebox imports no longer lose labels while reporting a clean success. Items import in parallel, so two rows arriving with the same label could collide, and the losing attach was discarded without a word: the item came back missing tags even though the import said everything worked. Colliding attaches are now retried, and anything that still fails is counted and listed in the import result.
