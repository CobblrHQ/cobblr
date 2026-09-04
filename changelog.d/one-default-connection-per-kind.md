---
type: fix
scope: core-ai
date: 2026-09-04
---
A workspace can have one default connection of each kind, and picking one no longer disturbs the others. Connections of every kind share one table, and the checks for "does this workspace already have an active one" did not say which kind they meant, so an active parcel-tracking connection answered yes to "is there an AI here". A workspace in that state reported no AI connected even with an approved key sitting right there, and the repair that runs at startup skipped it for the same reason. It also ran the other way: choosing which AI a workspace uses switched off its parcel connection as a side effect. Both directions are fixed, and affected workspaces switch their AI on by themselves when the server next starts.
