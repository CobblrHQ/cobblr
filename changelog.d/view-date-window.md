---
type: feature
scope: views
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#3.5 Views
---
**A view can ask for what is ready today.** A saved view can now compare a custom date field with today, so "Ready to drink" or "Past its best" answers for the day you are reading it on. Two new field meanings, *When it is ready from* and *When it is at its best until*, describe a window instead of a deadline, and a filter that cannot run is now shown on the view instead of being quietly skipped.

## docs

A saved view's filter can compare a date field with **today**. Pick the field, a comparison (before, on or after) and *today*, and the view keeps only the rows that match on the day you open it. Tomorrow it answers again for tomorrow.

For something with a window, like a bottle of wine or a cheese that ripens, give its two date fields the meanings **When it is ready from** and **When it is at its best until**. Neither one makes the item "go off", and the calendar never shows the start of a window as late.

If a view holds a filter that cannot run (for example, comparing a text field with a number), the view tells you above its rows rather than showing you everything as if it had been narrowed.
