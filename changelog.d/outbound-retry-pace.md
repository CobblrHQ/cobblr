---
type: feature
scope: integrations
date: 2026-10-16
docs_target: docs/USER_GUIDE.md#4.3 Wires (connecting events to actions)
docs_published: 2026-10-17
ui: none (the Send again button and the per-second fields shipped with the feature in b641bc3b88; this change only rewrites its docs)
---

A message to Slack, Discord or a webhook that meets a busy or briefly-down service is tried again, sent at the service's pace, and kept with a Send again button if it still fails

## docs

A send to Slack, Discord, a webhook or an HTTP connection is tried again by itself when the service refused it for being too busy (it asked you to wait) or too slow, or when it never reached the service at all (nothing answered at the address): five tries in all, a few seconds apart and then longer, and never sooner than the service asked. A webhook or HTTP connection sends a key with each message (the `Idempotency-Key` header, unless you name another header or `none`), so the service can drop a repeat, and with that key a server error or a timeout is tried again too. Slack and Discord take no such key, so after a server error or a timeout there the message may already have arrived: it is not repeated by itself, and its line says **May already have arrived. Check before sending again.** A failure because of the message itself (a refused address, a bad request) is never repeated, because it would fail again.

Each connection sends at its service's pace: Slack at most one message a second, Discord one every 0.4 seconds, and a webhook or HTTP connection at the rate in its **Most sends per second** or **Most requests per second** field (blank means no limit). A burst waits its turn instead of being dropped: thirty notices to Slack at once all arrive, a second apart.

Under **Configuration, Integrations, Recent calls**, every try is a line. A line marked **retry** will go again by itself and says when. A send that gave up says why (**Gave up after 5 tries**, or **Not delivered** when it was not worth trying again) and has a **Send again** button, which sends the same message once more. Cobb can send it again too, through the same connection.
