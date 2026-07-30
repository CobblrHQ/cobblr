---
type: fix
scope: scan
date: 2026-07-30
---
Fixed "Pick best (AI)" failing with "no vision provider is configured" on workspaces whose AI runs through an edge bridge or a local model. The feature only ever worked on two of the five AI providers. It now sends the candidate photos as one numbered contact sheet instead of ten separate images, which works on every provider, costs a fraction of the AI usage, and lets the model compare colours side by side. When it does fail, the message now tells you which of the three possible causes it was.
