---
type: fix
scope: core-ai
date: 2026-11-26
---
When the AI model a change is planned on takes the request and then says nothing for two minutes, Cobb now asks the next model on the same connection instead of failing, and the next request starts on the model that answered. When none is left, Cobb says the AI is taking too long to answer, not that it could not be reached.
