---
type: fix
scope: platform
date: 2026-08-26
---
Every public surface outside cobblr.me was showing the purple **staging** icon and calling itself "Cobblr · staging" - in the browser tab, and in the name a visitor would see if they installed it to their home screen. The per-environment icon gate was written when cobblr.me was the only public address, so it treated "not cobblr.me" as "internal". It now enumerates the internal hosts instead (the tailnet, localhost, a staging prefix) and everything else is Cobblr, which is also the safer way for it to be wrong: a new public address inherits the product's own identity rather than announcing itself as a test system.
