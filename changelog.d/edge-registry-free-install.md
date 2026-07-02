---
type: feature
scope: edge
date: 2026-07-02
---
Installing an edge bridge no longer needs any Docker registry: the generated command runs a stock public `node:22-alpine` image that fetches the bridge code straight from your own Cobblr (sha-verified) and keeps itself updated automatically — anyone can finish the install, on any network.
