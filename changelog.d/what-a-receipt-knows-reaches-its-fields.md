---
type: fix
scope: scan
date: 2026-08-25
---
Turning on a field preset now fills the new fields from receipts you already scanned, the backfill walks every item instead of stopping at the first two thousand, and it reports values that a field's fixed choices refused instead of dropping them silently. Creating a field that shadows a workspace-wide one warns you what changes hands, preset fields keep their explanatory text, a receipt that could not be read stays in your inbox with a Re-parse button instead of vanishing, and a feedback reply arrives on the channel you used rather than as an email and a Discord message saying the same thing.
