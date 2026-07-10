---
type: feature
scope: platform
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
docs_published: 2026-07-10
---
**Number fields can declare their unit.** Adding a number field (Configuration → Fields) now offers a **Unit** picker: "mm", "g", "in", or any unit from your workspace vocabulary. Values render as proper quantities everywhere ("12 mm", honoring your symbol-vs-word display preference), the input shows the unit while you type, and bundles can ship fields with units built in (the CNC tooling, fasteners, yarn, laser, pet-care, and plant-care bundles now do). A declared unit also tells Cobblr what a number physically *is*, which is what upcoming size-aware features read, never your field's name.

## docs

A **number field can declare its unit**: what the value is measured in. Pick one when adding the field (the Unit box appears for number fields; it offers the built-in vocabulary plus your workspace's custom units, or type anything). With a unit declared:

- values render as quantities wherever the field appears (list columns, detail pages, previews) as "12 mm" or "12 millimeters" per your **Units** display preference (symbol vs word, `/configuration/units`);
- the edit form shows the unit token next to the input, so it's always clear what the number means;
- bundles can ship unit-declared fields, and several flagship bundles now do (CNC tooling's diameters and lengths in mm and weight in g, fastener length in mm, yarn length per skein in m, laser wattage in W, pet weight in kg);
- Cobblr itself learns what the number physically *is*: a field whose unit is a length is a length, whatever you named it. Size-aware features (like the organize planner's fit checks) read this declaration. They never guess from field names.

The unit is free text under the hood: anything the vocabulary doesn't recognize still displays exactly as you typed it, and changing a field's unit never rewrites stored values (it's a label on the field, not a conversion).
