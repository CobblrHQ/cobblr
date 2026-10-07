---
type: feature
scope: locations
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#3.12 Locations (foundational)
docs_published: 2026-10-08
---
The floor plan draws things at their real size: a printer with an outer size takes its real footprint on the floor and its real width on a rack's shelf, and a shelf says whether what is on it fits ("3 machines, 1,278 of 1,220 mm: 58 mm too wide").

## docs

**Things at their real size, and whether they fit.** Give a thing an **Outer size** (width × depth × height of its outside, in any unit: "600 x 550 x 700 mm", "24 x 20 x 28 in") and the floor plan draws it at that size instead of as a pin: its footprint where it stands on a floor, its face on a rack's shelf. Things on a shelf stand side by side from the left; in **Edit layout**, drag one along the shelf to change the order, and Undo puts it back. Each shelf says how much of it they take ("1,278 of 1,220 mm: 58 mm too wide"), and the list under the plan names each shelf with the whole line ("Rack 1 shelf 2: 3 machines, 1,278 of 1,220 mm: 58 mm too wide"). A thing that runs past the end of its shelf, hangs off the front (deeper than the rack) or is taller than the space above the shelf is drawn red and says why; two things on a floor that overlap are drawn red too. A thing with no size stays a pin, and the plan offers **Add its size to see if it fits**: type the size for each thing in one sheet. The first size you save adds the **Outer size** field to every physical kind at once (it means the outside, never a printer's build volume), so you can also fill it in on the record's page, through the API (`metadata.outer_size`, read with the `outer-size` field role), or by asking the assistant.
