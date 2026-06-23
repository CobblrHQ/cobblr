---
type: fix
---
Scan matchmaker suggestions come back much faster. The AI now only writes an explanatory note when something genuinely needed reconciling (a title-vs-photo disagreement, an inferred field, an unconfirmed pack count) and omits it for a clean match — instead of always composing a 2–4 sentence paragraph. Typical routing dropped from ~18s to ~5s with no loss of useful explanations.
