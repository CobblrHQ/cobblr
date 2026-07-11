---
type: improvement
scope: scan
date: 2026-07-11
---
The put-away planner no longer dead-ends silently when there is no AI. Without a connected AI provider the planner can only reuse bins that already hold similar things, so a fresh workspace ended up with everything "unassigned" and only a faint "Similarity plan (no AI)" label to explain why. It now shows a clear, actionable notice: "No AI connected, the planner is grouping by where similar things already live, and won't propose new homes, so brand-new items stay unassigned," with a **Connect AI** link. When AI is connected but the plan call failed for a run, it says so and offers **Re-plan** instead.
