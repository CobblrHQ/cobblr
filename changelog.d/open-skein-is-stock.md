---
type: fix
scope: inventory
date: 2026-09-13
---
**An open skein with yarn left no longer shows as no yarn.** When you track yarn skein by skein and open the last one, the Yarn table used to say Qty 0 and Available 0 while the skein still had most of its metres, and the item went "low" the moment you opened it. The table now says "0 skeins + 1 open · 160 m", Available counts the open skein, and running low waits until that skein is finished too. Filament, tape and anything else tracked per unit reads the same way. A saved view no longer lists the opened skein as a yarn of its own; archived things stay out of lists and views unless a view asks for them, while search still finds them, marked archived, after the live ones.
