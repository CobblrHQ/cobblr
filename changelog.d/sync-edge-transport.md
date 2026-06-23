---
type: feature
scope: integrations
date: 2026-06-24
---
Sync connectors can now reach a **local source over an edge bridge**. When you add a connection you choose how Cobblr reaches it: **Direct** (the cloud fetches the URL — public URLs only on the hosted service) or **Via edge bridge** (a small agent on your own network fetches it and relays the result up). That's how you connect a LAN system like companion app to hosted Cobblr — the cloud never touches your private address; the bridge dials out and does the fetch locally.
