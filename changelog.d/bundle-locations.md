---
type: feature
scope: bundles
date: 2026-08-23
docs_target: docs/USER_GUIDE.md#4.4 Bundles (publishable presets)
---
**A bundle can now offer to set up the places its things live in.** Groceries offers a Kitchen with a Fridge, Freezer and Pantry inside it, so you can put a label on each and scan things straight in. If you already have a Kitchen, they go inside the one you have and nothing already in it is moved. It is a question at install, not something that happens to you, and declining changes nothing else about how the bundle works.

## docs

### Places a bundle sets up

Some bundles know roughly where their things live. Groceries knows a kitchen usually has a fridge, a freezer and a pantry.

When you install one, it offers to create those places. Three things are true of that offer:

- **It is a question, not an action.** You see what would be created before agreeing, and you can decline. A workspace might be an office, a workshop or a van, and nobody should have a freezer they did not ask for.
- **An existing place is used, never duplicated.** If you already have a Kitchen, the Fridge and Freezer go inside the one you have. Anything already in your Kitchen stays exactly where it is.
- **Only what is missing gets created.** If you already made a Fridge yourself, only the Freezer is added.

They are created as containers rather than as plain labels, which means you can print a QR label for the freezer, scan it, and have everything you scan afterwards filed into it.
