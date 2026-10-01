---
type: feature
scope: digifab
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-01
---
A 3D printer now has a Printing profile (its model, nozzle, build volume, default quality and a slicer preset per filament), and Cobblr can pick the best printer for a print: one the part fits, already loaded with enough of the right filament, and idle.

## docs

**Printing profile.** Open a 3D printer and fill in its Printing profile: the printer model as a short id such as `bambulab/a1`, the nozzle size, the build volume in millimetres, a default print quality, and, for each filament type loaded in it, the slicer preset you want used. With a slicer connected, the model, nozzle and quality become lists from that slicer, and choosing a model fills in its build volume and a nozzle it takes; without one, you type them. A connected slicer reads these to slice for this printer, and a part is only sent to a printer whose build volume it fits.

**Picking a printer.** Ask Cobb which printer should print something ("which printer should print a 60 by 60 by 20 mm part in black PETG, about 40 grams?"). It ranks your printers: the part has to fit, then one already loaded with enough of that filament and colour comes first, then an idle one, then the order of your pools. Every printer is listed with the reason, including the ones that were not picked. Picking sends nothing to a printer.
