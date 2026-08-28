---
type: selfhost
scope: selfhost
date: 2026-08-28
docs_target: none (the log message is the documentation, and CobblrHQ/docs#5 covers the guide)
---
Self-hosting over Tailscale now says so in the logs when no TLS certificate arrives, instead of leaving the first sign of trouble to the browser. It names the likely cause, lists which certificate names the node actually holds, and says whether fixing it costs a fresh approval.
