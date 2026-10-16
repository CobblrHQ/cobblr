---
type: feature
scope: integrations
date: 2026-10-16
docs_target: docs/USER_GUIDE.md#4.3 Wires (connecting events to actions)
---

A message to Slack, Discord or a webhook that meets a busy or briefly-down service is tried again, sent at the service's pace, and kept with a Send again button if it still fails

## docs

Sending to Slack, Discord or a webhook no longer loses a message when the other side is busy or briefly down. A failed try because the service is down, too busy (it asked you to wait) or did not answer is tried again by itself: five tries in all, a few seconds apart and then longer, and never sooner than the service asked. A try that failed because of the message itself (a refused address, a bad request) is not repeated, because it would fail again.

Each connection sends at the pace its service allows: Slack one message a second, Discord a little faster, and a webhook or HTTP connection at the rate you set in its **Most sends per second** field (blank means no limit). Thirty notices sent at once arrive all of them, a second apart, instead of being dropped.

Under **Configuration, Integrations, Recent calls**, every try is a line. A line marked **retry** will try again by itself and says when. If every try fails, the last line says why and **Gave up after 5 tries**, with a **Send again** button that delivers the same message once the service is back. Asking Cobb to send it again does the same.
