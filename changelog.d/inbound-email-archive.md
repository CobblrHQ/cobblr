---
type: feature
scope: core-scan
date: 2026-07-24
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
docs_published: 2026-08-07
---
**An emailed receipt is never lost, even if we hiccup processing it.** You send an email once. If something on our end fails to turn it into inbox items, that's ours to fix and replay, not yours to resend. Every message to your `receipts+...@` (or `reply+...@`) address is now stored raw the moment it arrives, before anything tries to parse it, and the outcome is recorded alongside it. So a message an older build would have dropped, or that hit a transient error, can be reprocessed from the backend through the current pipeline without asking you to send it again.

## docs
Emailed receipts (and reply-by-email) are now archived raw on arrival, before processing, and the result is recorded. If a message does not produce items (an old build dropped it, or a transient error), the team can replay it from the backend through the current pipeline, so you never have to resend an email you already sent. This is an operator capability, so there is nothing to configure or click.
