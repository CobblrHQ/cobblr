---
type: fix
scope: scan
date: 2026-07-11
---
**The put-away plan no longer shows two conflicting messages at once while re-planning.** When you re-planned, the "Re-planning… the current plan stays visible" banner and the stale "AI couldn't build a plan / No AI connected" notice both showed at the same time. The AI-status notices are now hidden while a re-plan is in flight, matching how the other banners already behave, so you see one clear message instead of two contradictory ones.
