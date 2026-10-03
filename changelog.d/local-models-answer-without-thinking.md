---
type: fix
scope: core-ai
date: 2026-10-03
---
**Local thinking models answer in seconds.** A model run with Ollama that can "think" (such as Qwen 3) used to think through every request, taking up to a minute where a few seconds would do. Cobblr now asks it to answer directly. An empty reply from a local model is treated as a failure, so the next AI you have set up answers instead.
