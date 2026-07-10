---
type: improvement
scope: platform
date: 2026-07-03
---
Two of today's bug classes can't come back. A new **authed-media lint** fails CI on any `<img src>`/`<a href>` pointed straight at a Bearer-authed file URL (the "broken images" class. It caught one more live instance on the way in, now fixed via a shared `openAuthedFile` helper). And an **action-predicate lint** requires every universal `appliesTo` to say *why* at the declaration site, new actions either scope honestly or justify themselves, so the Actions page can't silently rot back into a wall of untunable rows (it flagged three undocumented universals immediately; all three were legitimate and are now documented).
