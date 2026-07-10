---
type: feature
scope: core-ai
date: 2026-07-10
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
docs_published: 2026-07-10
---
**Cobb can now actually look at your workspace, and do several things at once.** Ask "which of my yarns would suit this pattern?" and Cobb *reads your real records* (search, list, fetch, under your own permissions) before answering, instead of guessing. Ask him to "save that pattern as a note and add the hook to my shopping list" and you get **each proposed change as its own card to confirm or skip**: writes still never run without your say-so, now including **updating fields** on a record and **deleting** one (where a module allows it). Works with every provider that supports tool calls (Anthropic, OpenAI, OpenRouter, tool-capable local models); anything else falls back to the old behavior gracefully.

## docs

Ask Cobb runs a real tool loop when your AI provider supports tool calling:

- **He reads before answering.** Questions about *your* data ("what's low on stock?", "which yarns are bulky?") make Cobb search/list/fetch your actual records: through your own permissions, so he can only see what you can see.
- **He can chain.** One request can end in several proposed changes ("save the pattern AND add it to the list"). Each arrives as its own card with Confirm/Cancel; approve some, skip others. Nothing runs until you confirm, same as before.
- **New write powers, same confirm gate:** besides creating records and running actions, Cobb can propose **field updates** and **deletions** for record kinds whose modules declare those routes (knowledge entries and tracking metrics today).
- **Provider support:** native tool calling on Anthropic, OpenAI, OpenRouter, and tool-capable OpenAI-compatible/local servers (a server that lacks tools is retried without them automatically). The Local-AI edge bridge passes tools through to its target: a target that ignores them simply answers text, and Cobb behaves exactly as he did before.
