---
type: feature
---
**See the files already on a printer.** The device modal now lists the gcode files on the printer's own storage (Duet via the edge bridge). It's **cached** (5-minute server cache, fetched once in the UI, never polled) with a manual **Refresh** — so a fairly-static list doesn't hammer the printer.
