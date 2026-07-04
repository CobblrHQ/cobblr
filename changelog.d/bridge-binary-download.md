---
type: feature
scope: api
date: 2026-07-04
---
Public download for the headless edge-bridge binaries: GET /api/v1/desktop/bridge/:os/:arch streams the prebuilt standalone binary for that platform, so the headless install script works with no token on or off the tailnet (it server-side-fetches the private release asset). Needs the operator to set EDGE_BRIDGE_REPO_API + EDGE_BRIDGE_REPO_TOKEN.
