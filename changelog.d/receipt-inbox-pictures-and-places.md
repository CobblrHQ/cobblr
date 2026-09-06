---
type: fix
scope: scan
date: 2026-09-06
---
Receipt lines fetch their pictures a few at a time, so a long receipt no longer
loses half its pictures to a throttled search; a line that finds none says so
and offers a retry. The closed card shows where an item is about to be filed,
and the session header says how many have a suggested spot instead of an amber
"Location" over items that all had one. A stale "Storage: Fridge" field value
is read as the place it names. A single receipt no longer asks whether its own
lines belong together.
