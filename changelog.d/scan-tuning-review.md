---
type: fix
scope: scan
date: 2026-08-05
---
Three fixes from reviewing the new scan tuning: the lens=wide override now selects the plain wide camera instead of accidentally matching a Wide-named composite lens, the diagnostics readout reports the settings actually in force rather than echoing the raw URL, and decode timing stats no longer count pauses as attempts.
