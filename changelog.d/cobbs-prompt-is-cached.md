---
type: improvement
scope: ai
date: 2026-10-11
docs_target: none (documented directly in docs/modules/core-ai.md "Cobb's prompt cache")
---
Cobb's instructions are now sent in the same order for everyone, so a Claude key reads them from its prompt cache instead of paying for them on every message: a cached chat message costs about a sixth as much. The AI page shows how much of each call came from the cache.
