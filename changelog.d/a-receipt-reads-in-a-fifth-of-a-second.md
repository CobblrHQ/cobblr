---
type: fix
scope: scan
date: 2026-09-18
---
**A receipt is read in a fifth of a second on a busy server, not a minute.** The text engine behind receipt review spun up threads that fought each other whenever the server had other work, and read every uploaded receipt twice. It now reads once, on one thread, and the wait does not grow with the load.
