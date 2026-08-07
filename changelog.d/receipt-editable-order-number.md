---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
**You can now set or fix the order number on a receipt session.** The parser reads an order or invoice number when the receipt states one, but sometimes it is missing or wrong. A receipt session header now has an editable PO number: add one so two receipts from the same store are distinct, or correct the parsed one, and the session title updates to match.

## docs
A receipt session in the scan inbox now has an editable order/invoice number in its header. Click "+ PO#" (or the PO# pencil) to add or change it; the session title becomes "Receipt · Vendor #<your number>". Useful when the parser did not find a number, or read the wrong one.
