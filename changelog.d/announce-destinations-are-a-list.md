---
type: internal
scope: release
date: 2026-08-23
docs_target: none (documented directly in docs/operations/CI_DEPLOY.md, "Announcing to more than one Discord")
---
Operator announcement webhooks take a **list** rather than a single URL, so adding a second Discord is a config edit instead of a change to every publisher. `CHANGELOG_DISCORD_WEBHOOK` and `CHANGELOG_ALERT_WEBHOOK` split on whitespace, newlines or commas; `ci-runner-health.sh` reads one URL per line from its webhook file. A single URL is a list of one, so nothing migrated. Each destination keeps its own delivery record (sent, resume cursor, message ids for a later correction) keyed by the webhook's own id, because sharing those three scalars across two servers makes the new one read as already delivered, makes a retry resume it at the other one's cursor, and points a correction at the wrong message. A destination added later is marked caught up without being sent; seeding one is `scripts/changelog-backfill.mjs`, which posts nothing itself and hands you the publisher commands to run one at a time.
