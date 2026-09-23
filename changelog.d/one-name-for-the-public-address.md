---
type: selfhost
scope: config
date: 2026-09-23
---
The instance's public address is read from one setting, `PUBLIC_BASE_URL`. An undocumented second name, `COBBLR_PUBLIC_URL`, is no longer read: some parts of Cobblr used it and others did not, so phone pairing and outgoing requests could miss an address that emails and printed QR codes used. If you set `COBBLR_PUBLIC_URL`, rename it to `PUBLIC_BASE_URL`.
