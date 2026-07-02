---
type: improvement
date: 2026-06-21
---
Cobblr cloud now hosts the edge-bridge's updates itself — a `/release` endpoint on the bridge tunnel serves the latest bridge code, so a bridge self-updates from Cobblr (the control plane it already authenticates to) instead of a Docker registry. No GitHub/Forgejo PAT, no registry, in the update path.
