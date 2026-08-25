---
type: fix
scope: scan
date: 2026-08-25
---
Scan intake is hardened for open registration: photo fetches from import files follow redirects through the same per-hop safety guard as every other fetched image, intake routes carry sensible per-workspace rate ceilings, an import caps at 5,000 rows with a clear message and a 200MB photo budget per run, a garbled AI reply is retried instead of being marked unreadable forever, and a photographed order confirmation now captures the seller and the promised delivery date the way emailed ones already did.
