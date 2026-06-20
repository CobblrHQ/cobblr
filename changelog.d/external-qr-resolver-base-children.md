---
type: improvement
scope: scan
date: 2026-06-20
---
External QR rules got simpler to set up and now cover every kind of label. Define a foreign system once — its **base URL** plus a list of `/segment/ → kind` children (e.g. `/printers/ → Machines`, `/parts/ → Parts`) — and one rule handles a whole host: the segment picks the kind, the trailing id resolves the item. Works for machines, parts, assets, and locations alike, and the seeding backfill now covers all four.
