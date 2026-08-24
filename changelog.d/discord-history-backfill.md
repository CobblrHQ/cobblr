---
type: internal
scope: release
date: 2026-08-24
docs_target: none (documented directly in docs/operations/CI_DEPLOY.md, "Announcing to more than one Discord")
---
A new Discord channel can be seeded with the whole public changelog history, one post per user-facing day, oldest first, via `scripts/publish/changelog-backfill-discord.mjs` - the Discord counterpart of the forum backfill. It reads the `changelog.d` archive rather than the publisher's state file, so it reaches back past the nightly cursor, and it renders through the same `lib/changelog-cards.mjs` the nightly uses so history and future look identical. Dry run by default, windowable by `--since`/`--until`/`--limit`, paced by `--pace`, and resumable through a local file since a webhook cannot read a channel's history. Also fixed 17 archive entries typed `feat` or `change` instead of `feature`/`improvement`: no surface could label them, so the nightly published cards titled literally "feat" and the forum backfill dropped them from the public history entirely. `lint:changelog` now checks the whole archive's types rather than only the entries a PR touches.
