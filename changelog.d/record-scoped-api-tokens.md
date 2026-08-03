---
type: feature
scope: auth
date: 2026-08-03
docs_target: none (developer-facing token capability; the user-facing API Recipes page ships next and will carry the user docs)
---
API tokens can now be scoped to a single record type and one action (create, read, write, or delete), and carry a provenance label recording where and why they were minted. A script or integration gets exactly the access it needs and nothing more, and a leaked token can only do what its scope allows.
