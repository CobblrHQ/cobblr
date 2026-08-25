---
type: fix
scope: platform
date: 2026-08-25
---
Tightened two authorization boundaries. A sandboxed app can no longer invoke workspace configuration actions (disabling a module, removing a field, renaming the workspace) through its scoped token, and Cobb now asks before deleting a record even when changes are set to apply automatically, so a delete always waits for your confirmation.
