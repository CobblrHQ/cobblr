---
type: improvement
scope: core-ai
date: 2026-07-09
---
Ask Cobblr got noticeably smarter and more consistent. Two workspaces used to give very different answers to the same question — one cause was a prompt-delivery bug where the managed AI silently dropped Cobb's workspace instructions (personal-bridge AI kept them), so they now behave the same. Cobb also stops deflecting real questions with "I only manage records" — it answers helpfully (general knowledge included) and *offers* to save the result. And it can now create more kinds of records straight from chat — anything a module exposes, like a knowledge entry — instead of a fixed short list. (Groundwork for full tool-calling — reading your workspace's contents and taking multi-step actions — is written up in docs/design-decisions/ai-chat-tool-calling.md.)
