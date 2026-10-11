---
type: fix
scope: ai
date: 2026-10-11
docs_target: none (documented directly in docs/modules/core-ai.md "Structured answers keep their shape")
---
A local AI, such as Gemma 4 through Ollama, now reads receipts, documents and scans in the shape Cobblr keeps: each reading tells the AI the exact layout to answer in, and an answer in any other layout goes to your next AI instead of being quietly dropped. Suggesting the kinds in a photo of an assortment, and the vision check for a failing print, now work too.
