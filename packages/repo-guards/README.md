# @cobblr/repo-guards

The writing and privacy rules every Cobblr repository keeps, from one source:

| Part | What |
|---|---|
| `identity/terms.json` | Terms nothing may ship or say in a commit message: people, boxes, the tailnet, private addresses, and secret patterns. Not in core's public export (the list is what it forbids). |
| `src/prose.mjs` | The prose rules for public writing: no em dashes, no performed candor, no signposting, no AI-marketing words. |
| `src/scan.mjs` | Matching terms in text and paths. |
| `bin/repo-guards.mjs` | The runner: `message <file>`, `staged`, `files [path...]`, `prose [path...]`. |
| `hooks/` | `commit-msg` and `pre-commit`, which call the runner. |

## In another repository

1. Depend on it, pinned like the engine: `"@cobblr/repo-guards": "<version>"` from the private registry.
2. Point git at its hooks: `git config core.hooksPath <node_modules path>/@cobblr/repo-guards/hooks`.
3. Optional `repo-guards.json` at the repository root:

```json
{
  "extraForbidden": ["\\bYarnCo\\b"],
  "ships": { "include": ["**"], "exclude": ["docs/internal/**"] },
  "prose": ["README.md", "docs/**/*.md"]
}
```

4. In CI: `repo-guards files` and `repo-guards prose`.

A rule changed in core reaches every repository on its next bump of this package. A deliberate internal reference in one commit: `COBBLR_ALLOW_IDENTIFIER=1 git commit ...`. A quoted line that trips a prose rule ends with `<!-- prose-ok -->`.

## In core

core's own gates (the public export, `lint-public-clean.mjs`, `lint-changelog.ts`) read the identity terms through `scripts/publish/forbidden.mjs`, adding each manifest's own `forbidden` extras. `scripts/prose-rules.mjs` re-exports `src/prose.mjs`. `scripts/the-identity-terms-have-one-home.test.ts` refuses a second copy of either, and any reader that skips the helper.
