---
type: feature
scope: scan
date: 2026-07-26
docs_target: none (documented directly in docs/USER_GUIDE.md 3.19 this PR)
---
Receipts that aren't a neat table now read **without AI**. A PDF or emailed receipt with no ruled line-item table used to cost an AI call; it's now read line by line for free. The reader only accepts a result when **the line items add up to the receipt's own subtotal**, so it can't hand you a confident wrong price: if the arithmetic doesn't reconcile it passes the job to AI instead. On a test corpus of eight store layouts it read every amount correctly, and invented nothing.
