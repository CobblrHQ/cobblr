---
type: fix
scope: digifab
date: 2026-09-29
---
The print farm now reports what the printer is really doing. A print is charged to its spool once, not once per status check; a Klipper printer still heating after Start is no longer read as a finished print; a print stopped at the printer reads as cancelled and takes no filament; and Cancel only shows a print as cancelled once the printer confirms it, saying so plainly when a printer can't be stopped from Cobblr. When a send or a print fails, the job says why in plain words, using the printer's own message when it gives one.
