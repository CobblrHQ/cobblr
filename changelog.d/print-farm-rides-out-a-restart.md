---
type: fix
scope: digifab
date: 2026-09-29
---
The print farm no longer sends a new plate to a Klipper printer that is busy with a print you started at the printer, and Duet printers now show whether they are printing. A printer's manager dropping off the network for a while no longer fails a print that kept running: the job says how long it has been out of reach and keeps checking. PrusaLink prints can now be paused, resumed and stopped from Cobblr, and a job caught half way through sending when Cobblr restarts goes back to the queue on its own.
