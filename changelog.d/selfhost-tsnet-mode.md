---
type: feature
scope: self-hosting
date: 2026-07-09
---
Self-hosting gains a fourth TLS mode: **`COBBLR_TLS_MODE=tsnet`**. The bundled proxy joins your tailnet as its own virtual node and serves Cobblr at `https://cobblr.<tailnet>.ts.net` with a real, auto-renewed certificate. The box needs no Tailscale install and nothing exposed; you paste one reusable auth key into `.env` and `docker compose up`. The blank-`COBBLR_ACME_EMAIL` crash in the DuckDNS/Cloudflare modes is fixed in the same image (the optional line is now dropped when empty).
