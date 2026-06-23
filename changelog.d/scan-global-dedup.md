---
type: fix
---
Re-scanning a barcode now always merges into the one pending item you already have, no matter which scanning session you're in — and moves it into the current session. Previously dedup was scoped per session, so re-scanning the same code in a new session created a duplicate (and the original looked like it had gone missing).
