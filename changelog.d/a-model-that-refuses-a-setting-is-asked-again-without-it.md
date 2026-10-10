---
type: fix
scope: core-ai
date: 2026-10-10
---
**Claude Haiku 5.5 reads receipts.** Claude's newest models refuse one of the settings Cobblr sent with every request, so a workspace on them could not read a receipt, plan where things go or name a scan session. Cobblr no longer sends it to those models, and any model that refuses a setting is now asked again without it and remembered.
