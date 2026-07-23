---
type: improvement
scope: deploy
date: 2026-07-23
docs_target: none (self-hosting install docs live in the docs site, updated alongside)
---
**Join a Tailscale hostname by clicking a link, no auth key to mint.** Self-hosting Cobblr behind its own tailnet name (`COBBLR_TLS_MODE=tsnet`) used to require pasting a reusable auth key from the Tailscale admin console. Now you can leave `TS_AUTHKEY` empty: on first start the box asks Tailscale to authorize itself, prints a one-time approval link, and you click it and sign in, the same flow you get authorizing any device. Setting a key still works for a fully headless join. Empty-key previously refused to start, so nothing that worked before changes.
