---
type: fix
scope: scan
date: 2026-09-03
---
A scan no longer files a place into a text field. When a match fills something like "room: Living room" and Living Room is a real place in your workspace, that value is taken out of the fields and kept as what it is, because where a thing lives belongs to Locations. It is decided in code rather than asked of the model, and it only acts when both the field and the value agree it is a place, so an irrigation zone or a tool-carousel bin is left alone.
