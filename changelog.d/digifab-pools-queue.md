---
type: feature
scope: digifab
date: 2026-06-18
---
Digital Fabrication can now run a **cross-machine queue**. Make a **pool** (a set of machines, even across different connections) then queue jobs onto the pool instead of a single printer. Cobblr drips each job onto the next *free* machine as printers finish, so you can throw a batch at your farm and walk away. It's how you run a pile of individual printers (OctoPrint, Klipper, …) as one farm without FDM Monster in the middle. Pure coordinate-not-control: Cobblr only picks which printer gets the file.
