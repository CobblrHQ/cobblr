---
type: feature
scope: scan
date: 2026-06-21
---
Operators can now **review barcode corrections** from a public approval queue. When an instance is set to *propose* mode, user fixes to wrong/missing barcode lookups land in **Super-admin → Barcodes → "Proposed corrections"** with the current value vs the proposed one — **Approve** makes it the verified answer every workspace's next scan sees, **Reject** drops it. Approval uses a server-side review token (super-admin only; never exposed to public users), so a public instance can both capture proposals and host the review without handing out write access.
