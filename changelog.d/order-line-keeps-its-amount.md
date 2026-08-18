---
type: fix
scope: purchases
date: 2026-08-17
---
An order line now keeps the amount its receipt stated, not only a per-unit price. A line whose total did not divide evenly by its quantity was recorded a penny or two off, because a per-unit figure rounds to two decimals and cannot always multiply back.
