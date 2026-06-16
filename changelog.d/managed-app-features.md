---
type: feature
scope: platform
---
**Managed apps ship with their curated features ON**: a managed app like "Cobblr for Yarn" is locked — there's no Configuration page — so a consumer could never turn on a bundle's optional features themselves. The managed-app registry now curates which features the app provisions with (`enabledFeatures`), and **both signup and auto-update apply them**. Cobblr for Yarn now arrives with **scan-a-ball-band, a Hooks table, an auto-restock shopping list, and a Designs/patterns table** — instead of a bare yarn table. Existing managed-app workspaces pick the features up on next use (the refresh reconciles the feature set, not just the version), and a graduation copies the app's feature set into the new full workspace.
