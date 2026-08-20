---
type: internal
scope: ai
date: 2026-08-19
---
The recorded AI test corpus now covers models that cannot call tools, not just those that can. Every cassette drove native tool calls, so the path a subscription bridge takes had no coverage, which is where three chat defects shipped. Added fixtures for that path, for plain prose answers, and for a tool call that fails, with a lint that fails the build if any of those disappear again.
