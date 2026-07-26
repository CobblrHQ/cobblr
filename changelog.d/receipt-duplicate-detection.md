---
type: feature
scope: scan
date: 2026-07-26
docs_target: none (documented directly in docs/USER_GUIDE.md 3.25c this PR)
---
Forwarding or uploading a receipt you already imported (same store and order number) no longer silently duplicates every line. Cobblr tells you it's already in your scan inbox and offers "Import anyway" if you really want a second copy. A receipt you'd discarded re-imports normally, and a receipt with no order number is never treated as a duplicate.
