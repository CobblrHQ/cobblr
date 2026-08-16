---
type: internal
scope: tooling
date: 2026-08-16
---
A workflow asking for a runner label no runner carries is now caught by a lint. Such a job is never scheduled, so it fails silently rather than red, which is how the coupling census shipped without ever running.
