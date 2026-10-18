---
type: internal
scope: docs
date: 2026-10-18
---
**The user guide is one page per area.** `docs/USER_GUIDE.md` was one 9,000-line file every feature appended to, so any two feature pull requests collided in the merge queue. Each area now has its own page under `docs/user-guide/`, the old file is an index whose moved-section stubs keep every old anchor, and `docs/user-guide/areas.json` maps each changelog scope to its page. A changelog entry still to publish names its area's page, an entry written before the split is followed to the page that holds its heading, and `lint:user-guide-index` refuses a section written on the index, naming the page it belongs on.
