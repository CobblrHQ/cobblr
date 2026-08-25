---
type: fix
scope: platform
date: 2026-08-25
---
Chat progress steps no longer go missing under load: a step that fails to save is now retried and logged instead of silently dropped, and two steps that race across servers can no longer claim the same slot, so a finished answer keeps every "thinking" and tool step it took.
