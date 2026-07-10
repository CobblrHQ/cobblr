---
type: feature
scope: locations
date: 2026-07-09
docs_target: none (documented in USER_GUIDE.md in this commit; no release-timed doc surface exists yet)
---
**Whole-house floor plans: floors as tabs, rooms that zoom.** A building's page now shows one plan per floor behind tabs ("Main floor" / "Basement"; "+ floor" creates them sized). Rooms draw on their floor as visible rectangles; clicking one zooms into the room's own plan in place, fully editable, without losing the house view. A toolbox's laid-out face zooms the same way. Dropping something inside a room re-files it there and lands it on the room's plan at the same physical spot.

## docs

A building doesn't get one plan. Floors are stacked, so each gets its own. On a house (an area with no plan of its own), hit **Split into floors**: each floor is created with its own outline and appears as a **tab** on the house's page. Rooms draw on a floor's plan as visible rectangles; click a room to zoom into its own plan in place (fully editable, with an "Open →" escape to its page); a toolbox with a laid-out face zooms the same way. Dropping an item inside a room's rectangle re-files it into that room and carries it onto the room's own plan at the same spot. Floors are ordinary locations otherwise: the tree shows them as thin dashed zones, and scanning and filing are unchanged.
