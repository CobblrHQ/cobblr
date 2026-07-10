---
type: feature
scope: platform
date: 2026-07-02
---
Cobblr now measures its own thesis. Every time someone hits a wall: a permission they don't have, an AI-built or pasted bundle that fails validation, a wire that errors or cycles, it's counted per workspace, and **GET /super-admin/product-metrics** rolls it up: walls-hit this week/month plus **time-to-first-working-app** (signup → first real item) for every workspace. Telemetry is sparse, best-effort, and self-pruning after ~180 days; it never slows a request.
