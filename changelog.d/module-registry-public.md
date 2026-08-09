---
type: selfhost
scope: marketplace
date: 2026-08-09
---

The module marketplace now reads a public catalog, so it works on a fresh install with nothing to configure. It used to default to a private address that answered "not found" for everyone who was not the maintainer, and the access token it asked for is no longer needed at all. Point it at a catalog of your own with `COBBLR_REGISTRY_URL`.
