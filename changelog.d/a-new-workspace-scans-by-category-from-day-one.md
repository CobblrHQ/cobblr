---
type: fix
scope: core-scan
date: 2026-09-20
---
**A new workspace groups its scans by category from the day it is made.** The scan category field on a workspace's catch-all table used to be created only when the server restarted, so a workspace made between two restarts scanned without it until the next update; on the hosted service that could be a day. It is now created the moment the workspace gets a table scans land in.
