---
type: fix
scope: core-scan
date: 2026-07-24
---
**The reply to an emailed receipt no longer calls a whole receipt "1 item," and it's shorter.** When a receipt can't be split into line items (for example when AI parsing isn't set up), it's saved as a single note so nothing is lost, but the reply used to say "captured 1 item," which read as if a seven line receipt were one thing. Now that case just says "we've got your receipt, see it in your scan inbox," with no misleading count, and the reply emails are trimmed to the essentials.
