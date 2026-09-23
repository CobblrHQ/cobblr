---
type: internal
scope: platform
date: 2026-09-22
---
**A nightly job is no longer lost when a change lands in the same minute.** The scheduler recomputes every job's next run whenever code lands, so a merge inside a job's minute quietly took that job's turn for the day: measured over a fortnight, two nightlies each lost a day, on exactly the days a merge landed in their minute. Every scheduled job now has a second turn or states why one is enough, and the later turn stands down when the day's run already happened, through one shared rule rather than a copy per job. A new check keeps the set honest, including refusing that rule where it cannot work.
