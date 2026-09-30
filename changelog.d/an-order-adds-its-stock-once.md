---
type: fix
scope: purchases
date: 2026-09-29
---
**An order that arrives adds its stock, and only once.** Marking an order arrived with its button, or answering "yes, it turned up", marked it arrived without adding anything to stock; only the status dropdown did. And an order set back and then arrived again added its stock a second time. Every way of saying an order arrived now adds each line's stock exactly once. Logging a past purchase is the other case: **New order** with status arrived now asks **Add these to stock**, ticked by default, and unticked the lines are recorded without changing stock.
