---
type: improvement
scope: digifab
date: 2026-07-11
docs_target: none (UI copy fix, no guide section changes)
---
**A "Needs you" printer now says why.** A machine flagged for attention on the fleet floor used to show an amber ring with no reason, most visibly on the camera wall. It now names the cause right on the tile in every view: clear the bed (a print finished), print failed, or a printer error. This covers prints that finished outside a Cobblr job (a Bambu started from its own slicer), which previously read as "Needs you" with nothing to explain it. (A firmware update being available is not a "Needs you" reason, and never was.)
