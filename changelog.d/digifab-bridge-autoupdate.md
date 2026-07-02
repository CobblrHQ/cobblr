---
type: improvement
date: 2026-06-21
---
The edge-bridge install now **auto-updates itself**. The Compose snippet bundles Watchtower scoped to the bridge, so it pulls new bridge versions automatically — no manual `docker pull`, no one becoming a sysadmin. Compose is now the default install (with a note explaining why); `docker run` stays as a manual-update option.
