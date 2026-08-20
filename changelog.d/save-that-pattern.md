---
type: fix
scope: ai
date: 2026-08-21
---
Cobb can save something into one of your own lists again. Saving a pattern into a Designs list failed with a bare "HTTP 400": that list calls its title "name" and the assistant offered "title", which is the same value under a different word. He now uses whatever word the list itself declares. When a save really cannot go through, you get the reason rather than a status code, and it names the field that was missing, so a second attempt can go differently from the first.
