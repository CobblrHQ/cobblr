---
type: feature
date: 2026-10-04
scope: inventory
docs_target: docs/USER_GUIDE.md#3.1 Inventory
docs_published: 2026-10-08
---
Filament spools show their use and remaining length, accept scale and firmware measurements, and can send Cobblr counts back to Spoolman.

## docs
**Spoolman is optional.** Cobblr tracks spools, their loaded printer slots and print use itself. On the Filament list, **Spoolman** connects an existing server and syncs its spools. Choose who records use: **Spoolman** pulls its remaining weight and skips Cobblr deductions; **Cobblr** keeps local deductions and sends absolute remaining weight and known location back. **Keep the saved choice** preserves that decision on later syncs. Failed publications are repaired by a five-minute sweep. Keep one authority per spool to avoid deducting a print twice.

A spool's Filament use panel shows remaining and used grams, lengths from known density and diameter, and first and last use. Weigh it subtracts tare and records a recount; Use by length records millimetres as grams. Firmware mode accepts manager use and skips slicer deductions. Filament types can import catalog records with vendors and editable price per kg; a job shows a current-price estimate.
