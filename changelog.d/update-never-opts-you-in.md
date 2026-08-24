---
type: fix
scope: bundles
date: 2026-08-24
---
Updating a bundle no longer switches on new optional features by itself. A
version that adds one now offers it, marked new and turned off, so nothing is
added to your workspace until you say yes. Previously a bundle update could
create locations you never asked for.
