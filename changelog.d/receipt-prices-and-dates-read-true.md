---
type: fix
scope: scan
date: 2026-08-25
---
Receipt prices and dates now read true: European amounts like 1.234,56 parse as one thousand and change instead of one and change, day-first dates like 18/08 no longer vanish, and each item on a multi-line receipt records its own line price rather than the whole basket's total. Receipts without an order number are also caught when you scan the same one twice.
