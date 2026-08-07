---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
**A receipt session now shows its order number, so two receipts from the same store are easy to tell apart.** When a receipt states an order, invoice, or confirmation number, the parser reads it and the inbox header shows it, for example "Receipt and KC Tool #384602" instead of just "Receipt and KC Tool". If there is no number, nothing changes.

## docs
When a receipt states an order/invoice/confirmation number, the scan inbox now includes it in the session header (for example "Receipt · KC Tool #384602"), so multiple receipts from the same vendor are distinct. Receipts without a stated number are unchanged.
