---
type: fix
scope: core-ai
date: 2026-07-14
---
**Splitting a group photo into separate items now actually uses the AI you were paying for.** When you split a photo of several things, Cobblr asks the AI to find each item and draw a box around it, so each new entry can be cropped to just its own item. That request was being quietly discarded before it reached the model: two of the three AI providers ignored the question and asked their standard "what is this item?" question instead, which of course came back with no list of items and no boxes. So the step fell back to the names it already had, and every split paid for a picture-reading call that could never have answered. It had never once worked. The question now reaches the model, so a split can crop each item out of the group shot as intended, and repeated splits of the same photo reuse one answer instead of paying again each time.
