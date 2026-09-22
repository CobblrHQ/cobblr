---
type: improvement
scope: assistant
date: 2026-09-22
---
The assistant is told which arguments an action cannot run without, before it calls it rather than after. Asked to group two fields under a heading, it used to learn that the heading and the kind of record were needed by having its first call handed back, then try again; now the action's own listing says which arguments are required and which pair is an either-or, so the first call carries them.
