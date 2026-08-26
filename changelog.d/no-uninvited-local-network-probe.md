---
type: fix
scope: platform
date: 2026-08-26
---
Opening **Configuration → Connections → Devices** no longer asks your browser for permission to reach other apps on your computer. The page was checking for the Cobblr desktop app on `127.0.0.1` the moment it loaded, and browsers now treat any request to your own machine as something you have to approve first, so people saw *"this site wants to access other apps and services on this device"* for a feature most of them do not use. It only looks when you ask it to now: the row offers **Check for it**, and says plainly whether it found anything. Inside the Cobblr desktop app itself nothing changes, since it answers directly without a network request.
