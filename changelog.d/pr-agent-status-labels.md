---
type: internal
scope: ci
date: 2026-10-08
---
Every pull request now carries the agent that owns it and one status label (draft, CI running, CI red, ready), kept current by the merge queue, which writes a label only when it changes; red notices go to that agent.
