---
type: feature
scope: core-ai
date: 2026-07-09
---
**OpenRouter, first-class: one key, any model.** Add an **OpenRouter** connection (workspace AI or your personal AI connections): paste your key, name a model (`anthropic/claude-sonnet-5`, `openai/gpt-5.5`, …), done, no base URL to know, and switching models later is editing one field. The generic **OpenAI-compatible** provider gains the same optional **Model** field, so vLLM and other exact-name servers work on a personal connection too (LM Studio still needs nothing). And Ask Cobb's create-from-chat got honest and smarter: modules now *declare* which records can be created from chat (knowledge entries and tracking metrics join in), Cobb is told each kind's **real field names** so a saved pattern lands with a proper `title` instead of erroring, and it never offers a create that would fail on confirm.
