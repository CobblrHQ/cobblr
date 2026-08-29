---
type: fix
scope: digifab
date: 2026-08-29
---
"Print started" and "Print complete" reach your Discord channel once per print again. Progress updates stopped doubling in the previous fix, but the start and finish messages did not: they are not on a cadence, so when a second copy of the server saw the same moment a few seconds later it announced it too. Each of these is now recorded against the print it belongs to, so whichever copy gets there first is the only one that speaks, and the next print announces normally.
