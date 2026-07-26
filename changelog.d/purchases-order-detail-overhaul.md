---
type: feature
scope: purchases
date: 2026-07-26
docs_target: none (documented directly in docs/USER_GUIDE.md 3.25c this PR)
---
Purchase orders got a real detail view: line items now link to the inventory item they created (with a thumbnail, and a clear flag if the part was deleted), receipt-imported orders show the actual receipt inline with a View button, and the vendor, order number, date, and total are filled in automatically at import instead of leaving the order blank. The footer reconciles the line items against the order total so a mis-read receipt is obvious.
