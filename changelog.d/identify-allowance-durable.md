---
type: fix
scope: scan
date: 2026-09-01
---

The daily allowance for hosted photo and barcode identification is now kept in
the workspace's database rather than in the api's memory, so a restart no longer
hands out a fresh day and two api processes cannot each grant the same last unit.
The number a hosted plan advertises is now the number it enforces.

Operators can also scope who gets it: `COBBLR_IDENTIFY_APPS=yarn` limits hosted
identification to workspaces locked into that app, so a deployment can give one
app a free allowance without giving it to every workspace on the box.
