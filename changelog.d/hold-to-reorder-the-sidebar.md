---
type: improvement
scope: navigation
date: 2026-08-24
---
Reordering the sidebar now starts on a short hold rather than as soon as you move, and letting go no longer opens the item you were moving. A quick press that drifts a few pixels counts as a click and follows the link, which it did not always do before. The case that failed every time was dragging the top item upwards, where the drop lands outside the list and the reorder is abandoned: the item opened as if you had simply clicked it.
