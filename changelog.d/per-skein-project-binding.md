---
type: feature
scope: inventory
date: 2026-07-13
docs_target: none (documented inline in docs/USER_GUIDE.md §3.1 in this PR)
---
Per-unit consumables (opt-in per item) now track parallel projects. Open a skein and assign it to a project, and its withdrawals post to that skein's own statement with the project as the reason; a second project can have its own skein open at the same time, and there is still never a total across them. When a project finishes with metres still on the ball, a clearly reusable amount returns to the pool silently while a small leftover asks a one-tap "keep it, or done with it?" (writing off leaves an explicit "written off" line, never a silent disappearance) - the threshold is a tunable percentage of the skein (15% by default). When a project's skein runs out you can continue it onto a fresh one in a tap. The per-skein/per-project cards appear only when you actually have parallel skeins or a binding, so a single working ball stays the simple count. Under the hood, consuming a reservation (and every stock-adjust) now writes the consumption ledger, so a project pulling from a bound unit finally leaves a statement line and the running balance is always right.
