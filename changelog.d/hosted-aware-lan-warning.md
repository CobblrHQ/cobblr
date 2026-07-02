---
type: improvement
date: 2026-06-20
---
The "that's a LAN address" warning in the direct-connect printer flow now only shows on a **hosted** Cobblr (cobblr.me / managed), which genuinely can't reach a device on your network. A **self-hosted** Cobblr on the same LAN no longer shows it — direct connection just works. Driven by a new `hosted` flag on `/auth/config`.
