---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-20
---

Klipper, OctoPrint and PrusaLink printers show their camera on the fleet card with no address typed

## docs

**A printer's own camera, with nothing typed.** A Klipper (Moonraker), OctoPrint or PrusaLink printer that has a camera set up shows it on its fleet card by itself: Cobblr asks the printer where its camera is and shows a fresh picture, which also works when you open Cobblr away from the shop network over https. A PrusaLink printer has a camera only on builds that support one. To use a different camera, open the card's camera settings and type its address; a typed address always wins. A printer with no camera shows its photo instead.
