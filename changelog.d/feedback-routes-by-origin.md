---
type: selfhost
scope: feedback
date: 2026-08-28
docs_target: none (documented directly in docs/design-decisions/public-cloud-instance.md)
---
Feedback raised in a chat server can now be announced back to that server instead of a single fixed channel, so an operator running both a private ops server and a public community one reads each report where it came from. Set `COBBLR_FEEDBACK_DISCORD_ROUTES`. Reports submitted in the app have no chat origin and keep going to the default channel.
