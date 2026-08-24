---
type: fix
scope: bundles
date: 2026-08-25
---
Installing a bundle now checks that the tables it promised actually exist, and
says which are missing when they do not. Tenant-side setup is best-effort, so a
half-finished install could report plain success and leave a workspace with the
bundle listed as installed and nowhere to file anything.
