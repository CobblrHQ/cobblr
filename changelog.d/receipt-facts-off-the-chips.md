---
type: improvement
scope: core-scan
date: 2026-09-07
---
**A receipt's own date and shop no longer repeat on every line.** The session header already says when and where the shopping happened, so a line's "Bought on" and "Acquired from" chips are dropped from the card's glance when they match the receipt. The values are still saved on the item and still show under All fields; only the chip that said the same thing twelve times is gone.
