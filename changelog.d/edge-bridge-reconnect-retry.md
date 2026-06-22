---
type: fix
---
Personal/BYO AI (the edge bridge) is more reliable under a flaky agent connection. The agent that carries your AI long-polls the cloud, and in the brief gaps between polls a request could hit "no edge device connected" and fail — which made the scan matchmaker fall back to "Matched by keywords (no AI)" even though AI was connected. Those momentary disconnects are now retried (a few seconds, with backoff) so the call waits for the agent's next poll instead of giving up.
