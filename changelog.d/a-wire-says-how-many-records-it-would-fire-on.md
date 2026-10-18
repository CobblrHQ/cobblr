---
type: feature
scope: automations
date: 2026-10-17
docs_target: docs/USER_GUIDE.md#4.3 Wires (connecting events to actions)
ui: none (the wire composer shows the count under its preview sentence and a list in the Target step)
docs_published: 2026-10-18
---
The wire composer now says how many existing records a wire fits right now ("2 parts of 3 in that state now"), updating as you change it, and says what the number means for the trigger. When a wire runs on linked records, the relationship is picked from the links in use in your workspace, with a way to type a new one. The assistant reads the same count and the same list before it sets an automation up.

## docs

**How many a wire would fire on.** Under the preview sentence the wire composer says how many records the wire fits right now ("2 parts of 3 in that state now"), and what that means for the trigger: a wire on an event fires as each record gets there, so the number counts the ones already there. When a wire runs on records linked to the one that fired, the relationship is picked from the links in use in the workspace, with `matches` and `holding-of` always offered, or typed if it is new. The assistant can read the same count and list before it sets an automation up.
