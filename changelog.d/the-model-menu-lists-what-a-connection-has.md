---
type: fix
scope: core-ai
date: 2026-10-02
---
**The model menu lists what each connection actually has.** A local Ollama, a self-hosted OpenAI-compatible server or a bridge now offers the models it reports, so a Claude bridge shows Sonnet, Opus and Haiku and no longer lists models it does not have. If a connection cannot be reached, the menu says "Couldn't list models" with a Retry. The AI settings accept any model your connection reports, so a model you pulled yourself can be chosen. Model names show in full, with the description underneath.
