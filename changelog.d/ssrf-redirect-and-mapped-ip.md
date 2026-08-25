---
type: fix
scope: platform
date: 2026-08-25
---
**Two more holes closed in the outbound-fetch guard.** An IPv4-mapped IPv6 address written in the form a browser's URL parser actually produces slipped past the internal-address check, which could have let a user-supplied address reach a loopback or metadata endpoint; it is now decoded and blocked. And server-side fetches of a user-supplied address (an image URL, a catalog source) now follow redirects themselves and re-check every hop against the same rule, so a public address that redirects to an internal one is refused at the redirect instead of being followed, and each hop's connection is pinned to the address that was checked.
