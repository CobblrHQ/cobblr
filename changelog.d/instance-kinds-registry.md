---
type: feature
scope: platform
date: 2026-07-10
docs_target: none (documented in USER_GUIDE.md in this commit; no release-timed doc surface exists yet)
---
**Named instances are first-class kinds now.** Every named instance (a "3D Printers" copy of Machines, a "Yarn" copy of Inventory) registers its own entity kind, synthesized from its module's declared primary kind. Instance items now place on floor plans, resolve in search, and are reachable by AI tools, all through the one registry, with instance-rooted endpoints that are never guessed.

## docs

Items in named instances (a "3D Printers" copy of Machines, a "Yarn" copy of Inventory) show up in a plan's "items here, not placed" strip and place like anything else. Under the hood every named instance registers its own entity kind, so search results and AI tools see those items the same way.
