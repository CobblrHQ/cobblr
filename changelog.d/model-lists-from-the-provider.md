---
type: fix
scope: ai
date: 2026-10-08
docs_target: none (documented directly in USER_GUIDE.md "Which model: latest, or a version you pin" and docs/modules/core-ai.md)
---
The model pickers for a Claude or OpenAI connection now list the models your own key can use, so Haiku, Sonnet and Opus 5.5 appear without an update. Each Claude family offers "latest" first, which follows new versions by itself, and exact versions to pin underneath. Existing Claude choices now follow their family's latest, and the activity feed says so once, for example "Now using Haiku 5.5. Pin 4.5 in Configuration → AI if you want it back." A call to a model whose price is not known yet shows "price unknown" instead of $0.
