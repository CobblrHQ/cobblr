---
type: feature
scope: core-ai
date: 2026-08-14
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
---
Ask Cobb can now see how your workspace is set up, your lists, saved views, automations, apps, templates and units, and can add a unit for you when you ask.

## docs

**Cobb can see how your workspace is put together.** Until now he could read your records but knew nothing about the workspace itself: the separate lists you run, the views you saved, the automations doing things in the background. Ask "how is my workspace set up?" and he covers all of it, or ask about one part:

- **Your lists (instances).** The separate lists one module runs, like 3D Printers and CNC both coming from Machines, with how many items each holds.
- **Your saved views.** What each one shows, how it is drawn, and whether it is pinned to your dashboard.
- **Your automations.** Every wire: what it does, what sets it off, and whether it is switched on. This is what makes "why did that happen by itself?" answerable, and "why didn't it?" too, since a switched-off wire is named as such.
- **Your apps, templates and units.** What you built, what your templates prefill, and which units you added beyond the built-ins.

An area whose module you have not enabled is simply left out of the answer rather than breaking the rest of it.

**He can build a view for you.** Ask for "a board of my open tasks" or "a calendar of what is due" and Cobb proposes saving it, pinned to your dashboard if you want. He says it plainly when you ask for a view of something this workspace does not track, rather than saving one that opens empty, and he understands the words people use: a board is a kanban, a timeline is a gantt.

**He can add a unit for you.** Say "we measure rope in fathoms" and Cobb proposes adding it, and once you confirm, fathoms is available on every quantity field. He checks the built-ins first and tells you when one already covers what you asked for instead of making a duplicate. Like every change he makes, it goes through the same confirm step and is recorded so you can undo it.
