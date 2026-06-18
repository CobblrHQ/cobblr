---
type: feature
scope: digifab
date: 2026-06-18
---
**Stuck print jobs can be re-pointed at a printer — no delete-and-recreate.** When a job's target matches no printer (or several), it lands in *awaiting assignment* instead of guessing. Now each such job in the queue has a **Pick printer** button: choose one from a searchable list and it's sent straight there — reusing the file Cobblr already uploaded, so there's no re-upload and no rebuilding the job from scratch. Picking a printer that isn't on that connection is refused, so a stray pick can't misroute the print.
