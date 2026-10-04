---
type: feature
scope: sales
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#Bringing sales orders in automatically
---
Sales gained automatic order intake from WooCommerce and a free email feed, with SKU mapping, source links, duplicate prevention and failures shown in Settings.

## docs

### Bring orders in automatically

Open Sales → Settings → Connect an order source. Choose WooCommerce orders
with your store's read-only key, or Order feed with the free email workflow.
Share the connection with the workspace. Choose it in Sales settings, map each
source SKU to an inventory part, enable automatic intake, and save.

Orders arrive confirmed and unpaid for review, without changing stock. Lines
without a SKU remain untracked. Repeated source references are skipped. If
Settings shows a missing mapping or a source failure, correct it and press
Check order source now. Prices are USD. Later store edits do not replace your
orders. Accounting remains a CSV export to your accounting tool.
