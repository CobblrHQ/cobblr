---
type: feature
scope: inventory
date: 2026-07-17
docs_target: docs/USER_GUIDE.md#3.1 Inventory
docs_published: 2026-08-07
---
Edit a table straight from the list: click any cell to change it, without opening the record.

## docs

**Edit from the list.** You don't have to open a record to change one field. On a
parts list, click a cell and it becomes an input: type, press Enter (or click
away) to save, Escape to cancel. Category and location open a dropdown, a
yes/no field is a checkbox you just tick, and a colour field opens the swatch
picker. It works the same on a phone, where the cards carry the same edits as
the table.

Each field gets the control it deserves, which is the same one you'd get on the
record itself, so a number never opens a text box and a colour never asks you to
remember a hex code.

Some cells don't open, and hovering one tells you why. A **computed** field is
worked out from your other fields, so there's nothing to type. An **automatic**
field is stamped for you. **Rich text** opens on the record, where there's room
for the editor.

**Quantity** is the deliberate exception: it keeps its **+/- steppers** rather
than becoming a typing box. Every tap writes a dated line to the item's history
with the amount it moved, which is what makes the "what did I use, and when"
story work. A free-text quantity box would overwrite that history with a guess,
so it stays a stepper. **Available** is quantity minus what's reserved, so it
follows along on its own.
