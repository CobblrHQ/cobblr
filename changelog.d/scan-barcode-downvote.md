---
type: improvement
scope: scan
date: 2026-07-15
---
When a photo proves a barcode's catalog answer wrong (a yarn skein that resolves to an action figure, then a reverse-phone-lookup site for the same spam code), the scan now casts a downvote to the shared barcode database instead of only clearing its own cache. Once enough separate workspaces independently disagree, that code stops serving junk and future scans of it go straight to naming it from your photo. It is a vote, not a block: a barcode that is legitimately shared is never suppressed by one workspace, and it is reversible.
