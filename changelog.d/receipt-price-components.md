---
type: fix
scope: scan
date: 2026-08-12
---
**A receipt's price is read as what you actually paid, not the sticker.** An order with a coupon used to record the pre-discount price, so "what did I pay for this" came back wrong by the discount with nothing to indicate it. Cobblr now reads the subtotal, discounts, tax and shipping separately, works out what the item cost you, and checks that those add up to what was charged. When they do not, it records the parts it is sure of and leaves the price for you rather than guessing.
