---
type: feature
scope: digifab
date: 2026-06-18
---
**Print farm safety.** The pool queue no longer auto-starts the next print on a printer that just finished: a finished (or failed) print now flags the printer **"needs clearing"** on the Fleet view, and the auto-assigner skips it until you tap **Cleared, ready**. No more crashing a fresh print onto a bed that still holds the last part. Two more hardening fixes ride along: a transient network blip while polling no longer flips a healthy in-progress print to "failed" (it retries a few times first), and a pool job whose send fails now shows up as **failed with the reason** instead of silently sitting "waiting" forever.
