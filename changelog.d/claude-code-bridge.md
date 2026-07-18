---
type: feature
scope: self-hosting
date: 2026-07-18
docs_target: none (docs shipped directly in this PR: USER_GUIDE 3.22 + bridges/claude-code/README.md)
---
Self-hosters can power their instance's AI with their own Claude subscription. A new claude-code-bridge (bridges/claude-code/) exposes an Ollama-compatible and OpenAI-compatible endpoint backed by the headless claude CLI on your own machine: register it as a local-server AI provider and chat, Ask Cobb tool-use, photo identify, and strict-JSON features run on your subscription with no API key and no metered billing. It queues bursts, caches identical calls, and reports every degraded state by name (needs login, resting until a stated time, model not on plan) instead of failing silently. Personal, single-tenant use only.
