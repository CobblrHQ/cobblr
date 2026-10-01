---
type: feature
scope: platform
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#2. Core concepts
docs_published: 2026-10-01
---
**Links show on both sides, on everything, once, in words.** Link a mod to the printer it is on and the printer lists it under Links ("has installed"), and a part says what uses it; parts and every other record now have **Link** too. Picking how two things are linked lists what they can link to straight away, so linking a mod to its printer and a part is six taps. The same link twice is refused and says why. The new **Printer mods** bundle is a table of mods that link to their printers ("installed on") and parts ("uses part"). New thing no longer suggests Machines for a name like "Printer mods".

## docs

**Links.** Every record has **Links**: what it is linked to, read from its own side
(*installed on Ender 3* on the mod, *has installed* on the printer, *used by* on a part).
Tap **Link**, pick how they are linked, then tap the other thing. A table can declare
its own links (the **Printer mods** bundle declares *installed on* and *uses part*), and
picking one lists what it can point at with nothing to type; anything else is *related
to*, found by search. The same link twice is refused, and removing a link keeps both
things.
