---
type: fix
scope: labels
date: 2026-09-13
---
**Print label from a record's page works again on a hosted instance, and a button that cannot run says why.** The item page's Print label shortcut refused on an instance with no public URL configured (the Labels page queued the same item fine) and showed only a flash of ERR. It now uses the address you are on, the way the Labels page does, and when any action cannot run, its own reason stays beside the button until you dismiss it.
