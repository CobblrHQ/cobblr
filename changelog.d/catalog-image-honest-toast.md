---
type: fix
scope: core-scan
date: 2026-07-24
---
**Picking a web-search photo for a scan item now only says "updated" when it actually worked.** Some image results can't be pulled in (the site blocks hotlinking, the link is dead, or it isn't a real image). Before, those still popped a success toast while the catalog photo silently didn't change. Now the pick fails cleanly with a "couldn't be used, try another" message and leaves your current photo alone.
