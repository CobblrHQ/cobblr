---
type: fix
scope: bundles
date: 2026-07-12
---
Updating a bundle that ships a reference catalog no longer risks the rows you imported into it. Bundle upgrades now preserve catalog data (the shell is refreshed in place, your imported rows stay), and only an explicit uninstall clears a catalog. This also closes an edge where a new version that removed a catalog could have dropped your imported rows without asking. Catalog-bearing updates still prompt for confirmation during the rollout, so nothing you imported is ever lost silently.
