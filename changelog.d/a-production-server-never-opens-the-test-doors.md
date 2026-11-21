---
type: security
scope: platform
date: 2026-11-22
---

A production server that finds the test-only workspace pool switched on refuses to start, so the test doors (sign-in tokens for pooled workspaces, failures planted for a test) can never be reached on a real service, even when the server is labelled as production.
