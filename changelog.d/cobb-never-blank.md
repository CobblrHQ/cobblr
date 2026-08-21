---
type: fix
scope: ai
date: 2026-08-21
---
Cobb no longer replies with an empty message. Some models answer a question about your records by attempting a tool call, malforming it, and sending nothing at all; Cobb now asks himself again for plain words, and tells you plainly if he still cannot answer. Replies from models that narrate their reasoning no longer show you that reasoning.
