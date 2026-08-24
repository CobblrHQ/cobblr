---
type: feature
scope: ai
date: 2026-08-24
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
Cobb can now rename a field, make it required, replace a dropdown's choices, or take a field off a kind of record. Name the field the way it appears on the form. A field that applies to a whole class of records (everything physical, say) is refused with a note about where it lives, so a change meant for one list cannot land on all of them.

## docs

Ask Cobb to change a field the same way you would ask a person:

- "rename the Colour field on parts to Shade"
- "make Purchase Date required"
- "add Aran to the yarn weight choices"
- "remove Shelf Life from parts"

He finds the field by the label you see on the form, and asks which you meant if two are close. Removing a field takes it off forms and lists; anything already recorded in it is kept, so adding the field back under the same name brings those values into view again.

One thing he will not do: change a field that belongs to a whole class of records rather than one kind. Those live on the Fields screen, because a change to one lands on every record in the class.
