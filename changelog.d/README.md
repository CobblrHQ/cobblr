# changelog.d — staged changelog entries

One file per change. Entries **stage** here, then the **8pm EST digest consolidates
them** (our daily "release"): it posts the `feature` entries to Discord, appends
them all to the permanent `CHANGELOG.md`, and removes the consumed files. So this
directory stays small (cleared daily); `CHANGELOG.md` is the growing archive the
`/changelog` page renders.

**Why files, not a shared `CHANGELOG.md`:** one file per PR = no merge conflicts
when multiple agents/people land changes in parallel. (The `changesets` model.)

## Format

```
changelog.d/<short-slug>.md
---
type: feature        # feature | improvement | fix
scope: bundles       # optional — the area
---
One user-facing line. Past tense, plain language, what changed for the user.
```

- `type: feature` → the **Discord digest** + the changelog page.
- `type: improvement` / `fix` → changelog page only (no Discord spam).

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
