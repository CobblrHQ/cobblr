---
type: fix
scope: platform
date: 2026-09-17
---
**An editor can now do everything an admin can do with the workspace's contents, not only install things.** An editor could install a bundle and then be told "ask a workspace admin" when creating the first record in it, because the capability check kept its own list of roles and had left editors off it. Every capability-gated action (creating records, adjusting stock, printing labels, using a worker app) now reads the same rank model as the rest of the product: owners, admins and editors hold every capability, and grants remain the way to give a member a specific one. Managing people, defining roles and deleting the workspace stay with owners and admins.
