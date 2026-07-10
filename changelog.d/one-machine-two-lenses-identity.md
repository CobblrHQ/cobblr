---
type: feature
scope: digifab
date: 2026-07-10
docs_target: none (docs updated in-place this PR: USER_GUIDE.md "Machine links." under 3.19 Digital Fabrication)
---
**Your fleet tiles and your machine records are finally the same machines.** A fleet tile whose device is linked to a machine now wears the machine's own name (the connection label demotes to the subtitle), and on the camera wall a printer with no camera shows the machine's photo instead of a dark void. In the other direction, the 3D Printers / Laser Cutters pages now show a small live chip on each linked machine (printing 46%, needs clearing, idle, offline) right beside its lifecycle state. The registry and the floor stopped being two disconnected identities: first slice of the one-machine-two-lenses plan (docs/design-decisions/machines-digifab-unification.md).

## docs

Linking a farm printer to a machine now unifies their identity everywhere:

- **The fleet tile wears the machine's name.** The connection label you typed at connect time demotes to the subtitle; unlinked devices keep the old naming.
- **The camera wall shows the machine's photo** when a device has no camera source, with a quiet "no camera" chip so it never reads as a live feed.
- **The machine's list page shows live status.** On 3D Printers / Laser Cutters, every linked machine's row and tile carries a chip (printing 46%, needs clearing, idle, offline) beside its lifecycle state, fed by the same fleet the floor uses.
