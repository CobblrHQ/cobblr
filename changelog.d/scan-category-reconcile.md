---
type: feature
scope: scan
date: 2026-07-30
docs_target: none (the reconciler ships here; the user-facing "File all N into X" surface lands with the UI change)
---
Scanned items no longer end up in near-duplicate categories. Cobblr now recognises that "apparel", "Apparel" and "clothing" are the same thing and can agree on one label for a whole scan session, so three shirts scanned together belong in one section instead of two. Items whose name was stored cut off mid-word also display correctly now, without needing a re-run.
