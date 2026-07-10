---
type: fix
scope: digifab
date: 2026-06-18
---
**The Fleet view stays fast and gentle on a big farm.** The live floor used to ask every connected machine manager for its printer list on every refresh, all at once: fine for a couple of printers, rough at fifty, where one slow manager could stall the whole view. Now each connection's printer list is **briefly cached** (a rapid refresh or a second screen reuses it), each fetch is **time-boxed** (a slow or unreachable manager falls back to its last-known state instead of freezing everyone), and the fetches run **in bounded batches** rather than a fifty-wide burst. Your in-flight jobs, links, and bed-clear flags are still read live every refresh, only the printer *state* can be a few seconds old.
