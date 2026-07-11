---
type: improvement
scope: scan
date: 2026-07-11
---
The put-away planner now self-heals a stale no-AI plan. Plans are cached (so reopening the sheet does not silently burn AI tokens), which meant a plan first built while AI was not connected stayed the similarity-only version forever. Now, when you open the planner and the saved plan is the no-AI one but your AI is connected, it re-plans **exactly once** with AI, caches the result, and never re-runs on its own again. The explicit Re-plan button is still there. Separately, the planner now passes the requesting user to the AI call, so a **user-scoped personal AI connection** (bring-your-own credentials) actually resolves instead of quietly falling through to the managed provider and landing on the heuristic.
