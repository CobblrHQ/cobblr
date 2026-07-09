# changelog.d — the live changelog archive

One file per change. **This directory IS the archive** — entries land here in the
same feature PR that ships the change, and stay. The `/changelog` page reads them
live (`GET /api/v1/changelog`), and the **8pm EST digest** posts that day's new
`feature` entries to Discord. Nothing consolidates or clears this dir, and the
digest is **read-only** — it has no repo write, no PR, no merge, no API token.
(Pre-cutover history lives frozen in `CHANGELOG.md`; the page reads both.)

**Why files, not a shared `CHANGELOG.md`:** one file per PR = no merge conflicts
when multiple agents/people land changes in parallel. (The `changesets` model.)

## Format

```
changelog.d/<short-slug>.md
---
type: feature        # feature | improvement | fix
scope: bundles       # optional — the area
date: 2026-06-17     # the day it shipped (used to group it on the /changelog page)
---
One user-facing line. Past tense, plain language, what changed for the user.
```

- `type: feature` → the **Discord digest** + the changelog page.
- `type: improvement` / `fix` → changelog page only (no Discord spam).
- `date:` → groups the entry on the page. Use the day you ship it. Missing → the
  entry shows under "Unreleased" until corrected.

## Staged docs (features only — write at merge, publish at release)

A `type: feature` entry ALSO carries the feature's user documentation, written
in the same PR while the feature is fresh
(docs/design-decisions/staged-docs-pipeline.md):

```
---
type: feature
scope: locations
date: 2026-07-09
docs_target: docs/USER_GUIDE.md#Floor plan   # where the docs publish
---
One user-facing changelog line (as before).

## docs

The user-manual prose. Staged here; scripts/docs-flush.mjs publishes it into
the target section once this entry's last commit is LIVE on the release
surface, then stamps `docs_published:`.
```

- `docs_target: <path.md>#<heading>` — the path must exist; the flush appends
  the prose at the end of that heading's section (creates it if missing).
- Contributor-facing / internal features opt out explicitly:
  `docs_target: none (<reason>)`.
- **Updating an unshipped feature? Edit its staged entry's `## docs` in the
  same PR** — that's the point: the docs stay fresh because they live in the
  diff. (The lint prints a nudge when your PR shares a scope with staged
  blurbs.)
- `docs_published:` is stamped by the flush — never write it by hand. After
  publish, doc corrections go straight to the target file.

## When (enforced by `lint:changelog`)

A **feature** — a `feat:` commit, a new `modules/<name>/`, or a module
minor/major bump — must add an entry here. A **bundle** feature is exempt: its
manifest `changelog` bump *is* its entry (the digest reads bundle bumps too).
Bugfixes / chores / docs-only changes are exempt.

## Definition of done (agents + humans)

A feature PR carries three things, all backstopped by CI lints:
`lint:versions` (bump the version) · `lint:docs` (update `docs/`) ·
`lint:changelog` (add a `changelog.d/` entry). Do them as you ship, not when the
lint catches you.

## Slug

Name the file for the change (`bundle-overrides.md`, `8pm-digest.md`). The content,
not the name, is what ships; uniqueness just avoids collisions.
