---
type: fix
scope: ai
date: 2026-09-28
---
A shared AI connection that a workspace owner stopped using no longer keeps answering for that workspace. A workspace's own AI providers are now always tried in the order they were added. Testing a bridge connection now checks it for real, including whether it can read a photo, instead of leaving it marked unverified.
