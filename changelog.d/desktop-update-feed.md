---
type: feature
scope: api
date: 2026-07-03
---
Auto-update feed for the Cobblr Edge Helper desktop app: GET /api/v1/desktop/updates/:target/:arch/:version answers the Tauri updater (204 when current, else the signed download), and super-admins publish a release via POST /api/v1/desktop/updates/publish. Lets the (private) helper auto-update through the hosted instance without public GitHub releases.
