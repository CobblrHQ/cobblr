---
type: fix
scope: core-ai
date: 2026-10-12
docs_target: none (documented directly in USER_GUIDE.md and docs/modules/core-ai.md)
---
An AI connection is marked **Verified** only once it has answered: saving or testing it now asks one tiny question with the model it will use, not just whether the key can list models. A model your account cannot use, such as an older Gemini model for a new Google account, reads **Model not available** in the provider's own words, and names the default model that does answer.
