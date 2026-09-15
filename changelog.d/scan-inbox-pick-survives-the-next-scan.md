---
type: fix
scope: scan
date: 2026-09-15
---
A destination picked on a scan inbox card no longer vanishes when the next thing is scanned into the same session: the session group kept its key on its newest item, so every arrival rebuilt the group and reset every card in it.
