---
type: improvement
scope: platform
---
The dashboard's "at a glance" grid now shows **one tile per instance** for modules that hold named instances — a Yarn-bundle workspace reads "Yarn" and "Hooks" (with their own counts), and projects reads "Designs", instead of a single generic "Inventory" / "Projects" tile. The empty auto-created default instance is dropped once you have named ones; a plain workspace with no bundles is unchanged.
