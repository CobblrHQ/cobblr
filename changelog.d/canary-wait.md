---
type: improvement
scope: operations
date: 2026-08-06
---
Deploys can now be confirmed with one command instead of by hand: canary-wait reports whether a given commit is live, checking the api build sha and the web image revision rather than guessing from bundle hashes.
