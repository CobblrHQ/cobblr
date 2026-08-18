---
type: internal
scope: tooling
date: 2026-08-17
---
The session-start sync now installs dependencies after it fast-forwards the shared checkout. A dependency one agent added used to go missing for every other agent at once, failing as an unrelated missing module while CI stayed green.
