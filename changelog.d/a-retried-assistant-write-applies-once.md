---
type: fix
scope: ai
date: 2026-11-19
---

An assistant's write sent again after a timeout applies once: every MCP write tool takes a request_id, and the same call with the same request_id is answered as the first was.
