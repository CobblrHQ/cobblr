---
type: feature
scope: digifab
date: 2026-06-18
---
**Print queue: live, cancellable, and no longer capped.** The queue now updates **on its own** while anything is running (no more stale snapshot: pool auto-assignment and print progress refresh live). Every job gets **Cancel** (tells the printer to stop where the manager supports it; otherwise marks it cancelled so Cobblr stops tracking it) and **Remove from queue** (a queued/finished job, an active print must be cancelled first so you can't lose track of it). And the queue no longer silently hides everything past 200 jobs: it pages, with a **Load older jobs** button and a status filter behind the API.
