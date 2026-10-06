---
type: feature
scope: digifab
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#Resin printers
---
Added resin printer stations with shared LAN control, liquid stock and wearing part tracking, wash and cure checklists, and Formlabs monitoring.

## docs

Add an SDCP resin printer through an edge bridge. Several LAN printers can use
one bridge, and any browser or tablet can be their machine station. Upload a
sliced GOO file to the print library, authorize the screen at the printer, then
review the file before Start. The review shows the resin volume and layer count.
Stop remains available while a file uploads; printer status confirms when it
has stopped.

For Formlabs, add a Dashboard monitor using your own API client ID and secret.
It shows the printers and current prints in that account. Dashboard does not
provide documented Start, Pause or Stop controls; use the printer's controls.

Load the resin bottle, optional vat, film and LCD stock at the station. Start checks the sliced volume against available resin and requires a fresh review after stock changes. Good and scrapped prints both record resin and wear use. After a good print, mark washing and curing as each finishes.
