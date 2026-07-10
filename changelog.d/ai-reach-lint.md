---
type: improvement
scope: platform
date: 2026-07-10
---
**New guardrail: entity kinds can't silently lose AI reach.** A new lint (`lint:ai-reach`, at pre-push + CI) requires every module's entity kinds to declare their create/update/delete routes (the ones Ask Cobb and the MCP server write through) or carry an explicit justification at the declaration site. The six deliberate exceptions (catalog entries, files, print jobs, order line items, measurements) are now annotated with their reasons, and the module-authoring guides record the rule.
