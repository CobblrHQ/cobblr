---
type: feature
scope: platform
date: 2026-07-21
docs_target: none (design doc docs/design-decisions/live-controls.md covers it; USER_GUIDE section lands with the full Live box writeup)
---
When a bridge scanner is connected, the Live box now carries a "Scans drive this screen" toggle with an Open/Print choice, so you can make any window follow scans from another device without going to the Scan page first.

## docs

The scan-drive session mode (a scan from a bridge scanner drives the screen you
pick) now lives as a control in the Live box (previously only a panel on the Scan page). It only
appears when a bridge scanner is connected. Flip it on to make this window the one
scans drive; the Open/Print switch decides whether a scanned label opens the item
or drops its label into the print buffer.
