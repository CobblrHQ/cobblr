---
type: feature
scope: ai
date: 2026-09-12
docs_target: docs/modules/core-ai.md#Sorting a list into sections, no AI
---
"Sort the rest of inventory into the right sections" is now worked out without AI: each record goes to the section its category names, a category with enough records for a section of its own gets one, and what is left (alone in its category, or with no category) is named for you or Cobb to place. One card, every line, Do it, Undo.

## docs
Say "sort the rest of inventory into the right sections", "put everything in inventory where it belongs", or "file everything on this page into the correct lists". The workspace reads each record's category: one that names an existing section moves there ("Groceries" into Groceries); a category with two or more records and no section gets a section of its own, named after the category; a record alone in its category, or with no category, is listed under the card and left where it is. Press Tab (or Do it) to run exactly what the card lists; press Enter and Cobb will also look through what was left and offer a card for the ones he judges belong somewhere.
