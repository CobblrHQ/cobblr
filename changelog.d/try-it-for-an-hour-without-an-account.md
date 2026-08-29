---
type: feature
scope: platform
date: 2026-08-29
docs_target: docs/USER_GUIDE.md#3.22½ Running a public demo instance (operator)
---
**Try Cobblr for an hour without making an account.** One link hands you a real workspace with a stocked kitchen and a shelf of books already in it, the scanner works, and everything you do is thrown away an hour later unless you press "keep this workspace" and give an email. Self-hosters can turn the same thing on with `COBBLR_TRY_SANDBOX=true`.

## docs

A no-account sandbox lets someone use a real workspace before deciding whether they want one. Turn it on with `COBBLR_TRY_SANDBOX=true` and a visitor who opens `/try` gets their own workspace, seeded from a blueprint, for `TRY_SANDBOX_TTL_MINUTES` (an hour by default). The link they land on is the credential and works for the whole hour, so a refresh or a second device still gets in.

Sandboxes are swept as they expire, and the sweep only ever touches workspaces the sandbox route itself created. Guard the door with `TRY_SANDBOX_MAX_PER_IP_PER_HOUR`, `TRY_SANDBOX_MAX_PER_HOUR` and `TRY_SANDBOX_MAX_LIVE` (a ceiling on how many exist at once), plus Cloudflare Turnstile if you have keys. Pressing "keep this workspace" binds an email, turns the sandbox into an ordinary trial, and retires the anonymous link.
