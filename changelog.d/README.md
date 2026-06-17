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
