---
type: feature
scope: locations
date: 2026-10-06
docs_target: docs/USER_GUIDE.md#3.12 Locations (foundational)
docs_published: 2026-10-08
---
Bring a whole house into the floor plan from one file: ask any AI with the copied prompt, paste what it gives you, check the preview, and import it as one step you can undo. Export gives the same file back.

## docs

**A whole house from one file.** On the Locations page, open the **Floor Plan** tab and choose **Copy a prompt for another AI**, paste it into any AI and answer its questions about your rooms; it answers with your home as a cobblr-floorplan/1 file. **Import a plan** takes that file (paste it or pick it): anything wrong with it is listed as you paste, with its line ("line 5, rooms[0].w_mm: w_mm is more than 0"), and a file that reads is previewed first: every room drawn, anything that reached outside its room moved inside and outlined in red, and how many places will be made or updated. **Import** does it as one step; **Undo** on its message takes it all back. Importing the same file again makes nothing new, so fix a room in the file and import it again. **Export** saves a house's plan as the same file, to hand to another AI for changes and bring back. The format, its JSON Schema and the prompt are in the docs: A floor plan as one file.
