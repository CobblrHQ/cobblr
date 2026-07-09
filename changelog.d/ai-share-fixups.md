---
type: fix
scope: core-ai
date: 2026-07-09
---
Cleanup from field-testing the shared-AI flow. The owner's offer email now says **Ask Cobb** (one last "Ask Cobblr" straggler); a workspace chatting through a **direct Ollama** provider gets Cobb's workspace instructions again (a prompt-delivery fix had missed that one adapter); resolving an offer clears the stale notification for **every** owner, not just the one who clicked; and the **Edge bridge ● online/offline** indicators now also cover URL connections that ride your bridge (LM Studio via bridge transit), not just the dedicated Local-AI connection.
