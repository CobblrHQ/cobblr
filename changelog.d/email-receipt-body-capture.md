---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
**Forward a receipt email even when it has no file attached, and always hear back.** Lots of store receipts arrive as an email body, not a PDF. Forwarding one to your `receipts+...@` address used to do nothing: the app only looked for a file attachment and silently dropped the body. Now, when there's no usable attachment, the email body is captured too. A body that reads like an item list ("2x PLA, 3 rolls tape") parses into one inbox row per line; anything else lands as a single note, so a forwarded receipt never just vanishes. Either way you get a reply telling you what landed ("Imported 4 items into your scan inbox") or that nothing usable was found, so "I emailed it and nothing happened" can't happen anymore.

## docs
Updated the Scan section of the User Guide: the "Email a receipt in" entry now covers the no-attachment body path and the reply you get back. Also updated `docs/operations/email-inbound-capture.md` (the receipts+ row now handles bodies with the same never-vanish safety net, plus the outcome notification).
