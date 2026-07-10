---
type: improvement
scope: scan
date: 2026-07-05
---
Scan routing suggestions are less noisy and more consistent. The matchmaker now asks the model for **one primary table plus at most one secondary** (only when an item actually belongs in two), and never to list the same table twice, instead of padding "up to 3" with a duplicate or a marginal table. So a batch of the same kind of thing (a shelf of books) routes the same way, instead of some getting a stray "Collections" and others a duplicate chip.
