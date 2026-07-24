---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
**Forwarding a store receipt email now works, and the reply talks back to you.** Most receipts arrive as an email you forward, with the receipt in the message body or its html, not as a file. That used to come back empty because the receipt content was being stripped before we ever read it. Now the full forwarded body and its html are read, so a forwarded receipt turns into inbox items like an attached one. The reply you get quotes what you sent and comes with Reply-To set to your receipts address, so if we could not find a receipt you can just reply with it attached and it lands straight in your inbox.

## docs
Forwarding a store's receipt email to your `receipts+...@` address now works even when the receipt is in the message body or its html (not a file attachment). The full forwarded content is read, so it becomes inbox items the same way an attached receipt does. The reply you receive quotes your original email and sets Reply-To to your receipts address, so you can reply with the receipt attached and it comes straight back into your scan inbox.
