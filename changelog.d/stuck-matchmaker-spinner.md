---
type: fix
date: 2026-06-23
---
Scan items can no longer get stuck spinning on "finding the best table…" forever. If the matchmaker step ever failed (e.g. a slow/timed-out AI call) it left no completion stamp, so the card spun indefinitely with no way to recover. Now the matchmaker records completion even on failure, and the card gives up the pulse after a few minutes — showing the identified item so you can route it by hand.
