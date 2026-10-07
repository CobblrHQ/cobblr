---
type: feature
date: 2026-10-05
scope: digifab
docs_target: docs/USER_GUIDE.md#LightBurn job review
docs_published: 2026-10-08
---
Added a floor manager with all machine queues, material dispatch, stock shortages and a shared monitor screen.

## docs

Open **Floor manager** from the Fabrication floor to see every laser and printer, their current job, ETA and assigned queue. Waiting for placement shows unassigned pool jobs and the material they need. Finished machines ask for a person to clear the bed. Station links take you to the existing machine screens.

**Dispatch by material** spreads SVG or DXF copies across available lasers with matching profiles and sheet area. Choose the drawing, material, quantity and layer operations, then preview every sheet. **Verify and queue batch** checks the finished projects in LightBurn and creates Production runs. Each sheet still needs approval and Start at its machine station. A blocked batch stays available to retry after restocking or withdraw before queueing.

Material on hand includes sheets, offcuts, usable free area and filament grams. Automatic printer pool assignment waits for the correct loaded spool with enough filament. Missing stock joins the existing daily low-stock digest; stock already on the shelf prompts loading. **Open shared screen** shows the same floor with larger type and no dispatch controls.
