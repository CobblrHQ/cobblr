---
type: fix
scope: ai
date: 2026-08-26
---
The bundle builder no longer asks the AI to follow an output schema while generating: on a local model it caused every request to time out, and on Gemini it produced replies with empty list items that crashed the build. Those replies are now cleaned up rather than crashing, and the schema constraint returns once the full bundle shape can be sent.
