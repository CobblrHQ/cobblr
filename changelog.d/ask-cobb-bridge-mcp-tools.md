---
type: improvement
scope: platform
date: 2026-07-12
---
**Ask Cobb can now read your workspace through a local AI that runs its own tools.** Some local AI backends are agents that run tools themselves and only return text, so they never hand tool calls back the way a metered API does, and Cobb couldn't see your data through them. Now you set **"How this AI runs tools"** on the connection (Ollama, OpenAI-compatible, or Local AI via edge bridge) to the "runs tools itself" option, and Cobb reads your real records through it. Each turn, Cobblr mints a short-lived, read-only grant scoped to just that one workspace, and hands the backend its own workspace address to read from, so one backend can safely serve several workspaces, each with its own grant. It is read-only through this path (Cobb can look, not change); to have Cobb make changes, connect a tool-calling provider (Anthropic, OpenAI, OpenRouter, or a tool-capable local server) instead.
