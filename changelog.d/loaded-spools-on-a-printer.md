---
type: feature
scope: digifab
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-01
---
Cobblr now knows which spool is on which printer. Every printer's page has a Loaded filament panel with one row per slot (4 for an AMS, 5 for an MMU). Load a spool by searching, by scanning it with the camera, or by scanning its label with a scanner while the printer's page is open. The spool it replaces goes back to its own shelf. When a print finishes, each filament's grams come off the spool in its own slot, so a two-colour print draws on both, and each spool's history names the print.

## docs

**Loaded filament.** A printer is a place, and the spools loaded on it are in it.
Open a printer and find **Loaded filament**. Set **Slots** once: 1 for a plain
printer, 4 with an AMS, 5 on an MMU. Each slot has **Load…**, or **Swap** and
**Take off** when a spool is in it. **Scan a spool** opens the camera and loads
what you point it at. With a scanner, scan a spool's label while the printer's
page is open and it loads instead of opening the spool's page.

Putting a spool into a full slot sends the one that was there back to the shelf
it came from. **Take off** does the same.

When a print on that printer finishes, the grams the slicer wrote into the file
for each filament come off the spool in that filament's slot. In the New job
sheet, **The spools loaded on the printer** is picked for you when the printer
has spools loaded. A slot with nothing in it takes nothing, and its grams are
never moved onto another spool.
