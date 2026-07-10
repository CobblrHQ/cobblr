---
type: feature
scope: digifab
date: 2026-06-18
---
**Drive a printer at home from a Cobblr in the cloud: no port-forwarding.** The print farm now supports the **device tunnel**: an edge agent on your network dials *out* to Cobblr and holds the connection open, so a hosted Cobblr can list, upload, print, pause, and track a printer behind home NAT exactly as if it were on the same LAN. Point a Digital Fabrication **edge-adapter** connection at `cobblr-edge://` and it routes through the tunnel instead of a direct URL. Two edge agents ship: the standalone **edge-bridge** (Docker/Pi) and a new **OctoPrint plugin** (`OctoPrint-Cobblr`) that also posts rich print updates, with a live webcam snapshot, straight to Discord. (It reuses the same proven dial-out path as Cobblr's local-AI relay. The cloud relay is hosted-only; self-hosted Cobblr on your LAN doesn't need any of this.)
