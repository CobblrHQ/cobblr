---
type: internal
scope: core
date: 2026-09-22
---
Security hardening: a custom app block and an installed file renderer are served from their own URL with their own sandboxed policy, instead of being written into the page as an inline document. That lets the app's script policy be tightened without those two surfaces going blank, and keeps each of them in an opaque origin that cannot reach the page around it.
