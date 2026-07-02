---
type: improvement
scope: digifab
date: 2026-07-02
---
Print jobs got much harder to lose: a cancelled job stays cancelled (the next status poll can no longer resurrect it), a scrapped/failed/cancelled job now puts its build's materials back into inventory and removes the never-made output, real farms tolerate ~3 minutes of manager downtime before declaring a print failed (and auto-retries wait for you to clear the bed), failed or cancelled jobs can be retried in place, and deleting a connection cleanly cancels and unlinks everything that depended on it.
