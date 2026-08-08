# changelog.d — the live changelog archive

One file per change. **This directory IS the archive** — entries land here in the
same feature PR that ships the change, and stay. The `/changelog` page reads them
live (`GET /api/v1/changelog`), and the **daily changelog publisher** announces
whatever shipped in each nightly — every user-facing entry, not just features —
as ONE post per surface (Discord + the community forum), the morning after.
Nothing consolidates or clears this dir, and the publisher is **read-only** — it
has no repo write, no PR, no merge.
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

- **Every type is announced.** `feature`, `improvement` and `fix` all appear in
  the daily post (Discord + forum) and on the changelog page, grouped by type.
  Discord used to carry features only, which meant it said nothing at all on the
  ~30% of days that shipped no feature while the forum published a full day's
  work. Same entries, same day, both surfaces.
- **Internal pipeline noise is dropped automatically** by
  `scripts/publish/changelog-filter.mjs` (the canary channel, the release job,
  a new lint). Write for a user and you never think about it.
- `announce:` is **obsolete** and ignored — it existed to opt a major fix into a
  features-only Discord feed. Harmless if present; stop adding it.
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
- **`## docs` and a real `docs_target` belong to `type: feature` only.** The
  flush walks features and nothing else, so the same section on an
  `improvement` or a `fix` is never read: it looks staged and is dead. Five of
  them were found sitting like that (2026-08-08), each naming a real
  `USER_GUIDE` section, none of the prose ever having reached the manual, and
  `docs-flush --dry-run` reporting "nothing to publish" the whole time. For a
  non-feature, write the docs **in the same commit** and say so:
  `docs_target: none (documented directly in USER_GUIDE.md <section>)`.
  `lint:staged-docs-reachable` enforces it.
- **Updating an unshipped feature? Edit its staged entry's `## docs` in the
  same PR** — that's the point: the docs stay fresh because they live in the
  diff. (The lint prints a nudge when your PR shares a scope with staged
  blurbs.)
- `docs_published:` is stamped by the flush — never write it by hand. After
  publish, doc corrections go straight to the target file.

## The PUBLIC docs site is tracked separately

`docs_target` and the flush only touch **this repo's** `USER_GUIDE.md`. The public
Docusaurus site (`CobblrHQ/docs`) has **no automatic wire to the changelog** — a
feature here does not update a public page on its own. That site reconciles
against the changelog with its own report (`npm run docs:debt` there, which reads
`changelog.d/` and routes each user-facing entry to the pages it should update,
**keyed by `scope:`** — which is why `lint:changelog` now requires a scope on
every feature). So a good `scope:` on your entry is what keeps the public docs
from going stale, not just this repo's manual.

## Voice (enforced by `lint:changelog`)

Entries and their `## docs` bodies are user-facing writing: the one-liner feeds
`/changelog` and the Discord digest, and the docs body is spliced verbatim into
the public docs at release. Write like a person explaining their own product
plainly. The mechanical rules live in ONE place, `scripts/prose-rules.mjs`
(shared with the docs site's lint), and the gate applies them to every entry a
push touches. The short version: no em dashes; no candor-performance
("honestly", "the honest truth", "genuinely" as an intensifier); no signposting
("worth noting", "the key thing is"); no "not just X" reframes; no
AI-marketing words (seamless, leverage, empower). A genuine false positive can
end its line with `<!-- prose-ok -->`.

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
