---
type: fix
scope: scan
date: 2026-07-30
---
Closed three gaps left by today's scan-photo fixes. Four photo-gallery endpoints were still returning an item without composing the colour into its title, a truncated name was only being cleaned up on one of the paths that can produce one, and nothing would have noticed if the server image lost the fonts that make the AI photo picker's tile numbers readable.
