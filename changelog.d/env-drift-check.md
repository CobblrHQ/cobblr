---
type: selfhost
scope: deploy
date: 2026-09-01
---
The automatic updater never re-reads your `.env`, because it re-creates each container by cloning the environment the old one had. That means an edit you made can sit unapplied while fresh containers keep starting on new images, with nothing reporting it. The self-hosting README now says so, and a new `check-env-drift.sh` next to the compose file tells you whether it has already happened, naming the keys that differ and never the values.
