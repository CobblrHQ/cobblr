---
type: feature
date: 2026-06-20
---
**Reach a LAN machine from a hosted Cobblr.** A hosted instance (strict egress) can't dial your home network directly — so now an on-site **edge bridge** dials OUT to Cobblr and holds a tunnel open; Cobblr routes printer commands down it. Create an `edge_adapter` connection with a `cobblr-edge://` address and the bridge handles the rest. No inbound firewall hole, no SSRF surface (the cloud never fetches a private IP). The tunnel now powers connection-test and device-listing too, not just job send/poll.
