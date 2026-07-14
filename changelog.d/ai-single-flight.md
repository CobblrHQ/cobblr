---
type: improvement
scope: core-ai
date: 2026-07-14
---
**Scanning several things at once no longer makes the same AI request several times over.** When you split one photo into separate items, or a burst of scans arrives together, Cobblr could send the AI the exact same question several times in parallel: each request checked the cache and found nothing, because none of the others had finished writing their answer yet. Now an identical request that is already in progress waits for that one and reuses its result. It applies only to identical requests happening at the same moment; a deliberate retry still makes its own fresh call.
