---
type: feature
scope: feedback
date: 2026-08-06
docs_target: docs/USER_GUIDE.md#4.7 Notifications
docs_published: 2026-08-07
---

Self-hosted instances can now turn a feedback note into a ready-made bug report
for the public issue tracker, with the version, browser and enabled modules
already filled in.

## docs

On a self-hosted instance your feedback stays on your own box: the row lands in
your own database and only your own super admin sees it. That is what you want
when you host for other people, and it means a bug in Cobblr itself never
reaches us. So self-hosted instances get two extra buttons next to Save to this
instance: Copy report puts a markdown bug report on your clipboard, and Open an
issue opens the public tracker with it prefilled.

The report carries what a maintainer always asks for anyway: build version, Node
and Postgres versions, server platform, the route you were on, your browser and
viewport, and the modules enabled in that workspace. It carries nothing else, no
names, no emails, no counts, no environment values, and you can read all of it
before you send it.
