---
type: improvement
scope: core-scan
date: 2026-07-24
---
**Multiple pending receipts collapse into one purchase-order prompt.** Each parsed receipt used to add its own "Confirm as purchase order" banner, so a few receipts stacked up a wall of them. Now, with more than one, you get a single line ("3 receipts to confirm as purchase orders") with Confirm all, and you can expand it to confirm each on its own. A single receipt looks exactly as before.
