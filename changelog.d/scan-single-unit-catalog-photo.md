---
type: improvement
scope: scan
date: 2026-08-14
---
When Pick best (AI) chooses a catalog photo that shows two or more of the same item, the picture is now cropped to one of them. The chosen photo is still the one the ranker judged most accurate, and it costs no extra AI call: the same pass that picks the photo now also reports how many units it sees. A photo whose units overlap or cannot be cleanly separated is left whole.
