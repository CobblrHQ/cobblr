---
type: improvement
scope: integrations
date: 2026-06-24
---
Outbound requests from connectors now route through one per-tenant egress policy. On the **hosted** service, a sync connector can reach public hosts and your own registered edge connector, but **not** arbitrary private/internal addresses (a tenant can no longer point a connection at a LAN or internal IP). Self-hosted instances are unchanged (your own LAN is allowed). To connect a *local* system (like companion app) to hosted Cobblr, use an edge connector rather than a direct LAN address.
