---
type: improvement
scope: scan
date: 2026-08-19
---
A receipt import now adds up the lines it read and checks them against the total the receipt charges, and tells you when the two disagree. A per-item coupon is the common cause: it is not an item, so the items sum higher than you actually paid, and until now nothing said so.
