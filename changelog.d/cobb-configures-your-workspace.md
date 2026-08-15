---
type: feature
scope: platform
date: 2026-08-15
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
---
Ask Cobb can now change your workspace's own setup, with your confirmation: add a custom field, create a separate list from a module, and switch an automation on or off.

## docs

**Cobb can configure the workspace itself.** Three things that used to mean a trip through Configuration now work by asking, each behind the same confirm step as every other change he proposes:

- **"Add a field called finish to my parts, a dropdown of matte and gloss."** He adds the custom field, on one kind of record or on a whole class of them ("put an origin field on everything physical"). He speaks your words: a dropdown, a checkbox, a date. He tells you plainly when a kind does not exist, when a dropdown is missing its choices, or when the field is already there, and he cannot edit or delete existing fields, only add new ones.
- **"Make me a separate list for my CNC machines."** He creates a skinned list from a module you already have, born complete: its own nav entry, its own item noun, ready to hold records the moment you confirm. He refuses politely when the name is taken or the module is not enabled, and names what is in the way.
- **"Turn off the wire that auto-prints labels."** He can switch any automation on or off by asking, and the change is recorded with who did it, so "why did my automation stop?" always has an answer. He cannot create or edit automations, only toggle what you built.

Every one of these is a proposal first: nothing changes until you confirm, and each change lands in the activity log. Members need an admin-granted permission per operation; owners and admins can use them as they can the Configuration screens.
