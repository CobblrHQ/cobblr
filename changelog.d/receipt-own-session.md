---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
**An emailed or uploaded receipt now lands as its own labeled group in the scan inbox.** Before, a receipt's line items dropped into the inbox under a plain timestamp and could get mixed in with whatever else you were scanning at the time. Now each receipt is its own session with a clear header: "Receipt and the vendor" when the vendor is detected, otherwise just "Receipt", and an emailed one adds "emailed" with the time. The line items are grouped under that header, so a whole receipt reads as one thing you can triage together.

## docs
A receipt you upload or email in now becomes its own session in the scan inbox, with a labeled header (the vendor when detected, otherwise "Receipt", plus "emailed" and the time for an emailed one) and its line items grouped underneath. This keeps a receipt's lines together and separate from other scanning you were doing at the same time.
