---
type: feature
scope: locations
date: 2026-10-01
docs_target: docs/USER_GUIDE.md#3.12b Containment: what's inside your things (core-placement, foundational)
---
Anything that holds things, like a backpack or a toolbox, now works as a place: headphones in a backpack read "Backpack, in Desk drawer" in the list, search and the assistant, and the backpack can be picked wherever a place is chosen.

## docs

**Things that hold things are places too.** Put your headphones inside a Backpack (its Contents panel, or the Location picker) and the headphones say where they are, every step up: **Backpack, in Desk drawer**. The same line shows in the list's Location column, under Where it's kept, in search's where-is-it chip, in an export, and in what the assistant answers when you ask where they are.

- **Picking it.** Every Location picker on a record (a part, an asset, a record) has an **Inside something** group under the places: every record that holds something right now, each with where it is itself, so two toolboxes can be told apart. Choosing one moves the thing inside it. Choosing a shelf moves it out of the Backpack and onto the shelf; clearing it takes it out.
- **Move everything.** A place's **Move everything to…** can empty it into a Backpack as well as into another place. The places inside it cannot go into a Backpack, so that combination is refused with the reason; Undo puts everything back.
- **Scanning.** Live sort's **Different bin…** and File everything's **New ones go to** offer the same Inside something group, so a scanned thing can be filed straight into the Backpack.
- **Floor plan.** A Backpack on a plan says what it holds ("holds 3 things"), since the things inside it are not drawn.

A record starts being offered as a holder once something is in it: use its **Contents** panel to put the first thing inside.
