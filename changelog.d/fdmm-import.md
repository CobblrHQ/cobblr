---
type: feature
scope: digifab
date: 2026-06-18
---
**Migrating off FDM Monster?** Digital Fabrication now has an **Import farm** button. Point it at your FDM Monster and bring its printers in two ways, your choice: **connect to each printer directly**: Cobblr recreates every printer as its own connection of the *matching* type (OctoPrint, Klipper/Moonraker, PrusaLink, FluidNC: per printer, not all-OctoPrint), installs the drivers it needs, pools them, and drops FDM Monster from the path; or **keep FDM Monster and mirror its printers** into a Cobblr pool. Either way the Fleet reads the imported machines as one farm.
