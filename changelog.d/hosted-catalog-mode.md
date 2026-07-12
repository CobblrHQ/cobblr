---
type: feature
scope: catalogs
date: 2026-07-12
docs_target: none (design in architecture/shared-reference-catalogs.md; operator-facing)
---
On a hosted deployment, a large reference catalog (Rebrickable) can now be served from one shared, centrally-refreshed copy instead of imported into every workspace. Installing such a catalog links to the shared copy automatically; matching, hydration, and disassembling a set all read from it. Self-hosters are unchanged: catalogs import into the workspace as before.
