---
type: fix
scope: scan
date: 2026-09-24
---
The Scan Inbox's counts no longer change as you scroll. "To review", "ready" and "waiting" count every scan in the inbox, not the ones loaded so far, and the review and waiting filters find every matching scan, including ones further down the list. A session that spans the end of a page now loads whole, so its count and its File all cover all of it.
