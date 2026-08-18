---
type: feature
scope: locations
date: 2026-08-18
docs_target: docs/USER_GUIDE.md#3.12 Locations (foundational)
---

Ask Cobb can put your locations in order. Say which shelves or racks under a
place should come first and Cobb sets that order, the same order dragging them
in the tree produces. It orders one parent's children at a time, and it will
tell you if you have mixed locations from different parents rather than quietly
renumbering both.

## docs

Ask Cobb can reorder sibling locations. Ask it to put the children of a place in
a given order and it applies that order to the tree. Ordering is per parent: one
group of siblings at a time. This is the only way the order changes, so an
attempt to edit a location's position directly is refused with a pointer to
this instead.
