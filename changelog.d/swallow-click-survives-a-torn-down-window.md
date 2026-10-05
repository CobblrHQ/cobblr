---
type: internal
scope: web
date: 2026-10-05
docs_target: none (internal test-stability fix)
---
The click-swallow after a drag no longer throws when its page is torn down mid-timer, and returns a cancel for unmounts.
