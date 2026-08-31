// WHERE DOES THIS GO — the map you read BEFORE writing a file, not the lint
// that tells you afterwards.
//
// The loop this replaces, observed 2026-08-31: a new sheet was written into
// web/src/components/, `lint:all` said "generic components must not hardcode a
// module entity kind", and it moved to web/src/pages/. Nothing was wrong with
// the lint. The cost is that the answer only ever arrives after the work, and
// arrives again, the same way, for the next person and the next agent, who did
// the same research to get there.
//
// So: ask first. `pnpm run where "a sheet for the locations page"` prints the
// directory, a REAL file to copy the shape from, and the rules that will judge
// it before CI does.
//
// ── WHY THIS CANNOT ROT ──────────────────────────────────────────────────────
//
// A map of a codebase is exactly the kind of document that goes stale in a
// month, and a stale map is worse than none: it is indistinguishable from a
// true one (that is not a guess — a stale design record sent an agent to the
// wrong answer about the canary channel two days ago). So every fact here is
// checkable, and `lint:placement` checks all of them on every CI run:
//
//   1. every `dir` exists;
//   2. every `exemplar` file exists — the shape you copy is a live file, never
//      a snippet pasted here that nobody updates;
//   3. every lint named by a row exists in package.json;
//   4. a NEW lint script must be claimed by a row or declared GENERAL. That is
//      the one that matters: enforcement cannot be added to this repo without
//      saying which kind of work it governs, so the map grows with the rules
//      instead of falling behind them.
//
// The rules themselves are NOT restated here. Each row names the lints that
// judge it and the tool prints their one-line rule from the lint's own header,
// so there is one copy of every rule and it lives in the thing that enforces
// it.

export interface PlacementRow {
  /** Stable id, kebab-case. */
  id: string;
  /** What you are building, in the words someone would actually type. */
  what: string;
  /** Words that should match this row. Include the wrong guesses people make. */
  keywords: string[];
  /** Where it goes. A path, or prose when the answer genuinely is "next to the
   *  thing it belongs to" — prefix those with "beside:" so the checker knows
   *  not to stat them. */
  dir: string;
  /** A REAL file to read first and copy the shape from. */
  exemplar: string;
  /** Why here and not the neighbouring place. One sentence. */
  why: string;
  /** package.json lint scripts that will judge this kind of file. */
  lints: string[];
  /** Anything that is a decision rather than a rule — pick these carefully. */
  notes?: string[];
}

export const PLACEMENT: PlacementRow[] = [
  {
    id: "generic-web-component",
    what: "a web component that works for ANY module's records",
    keywords: ["component", "shared component", "generic", "reusable ui", "widget"],
    dir: "web/src/components/",
    exemplar: "web/src/components/EntityAttachments.tsx",
    why: "This layer is module-agnostic: it may not name a module's entity kind, because doing so silently excludes every module added later.",
    lints: ["lint:component-kinds", "lint:hooks-after-return", "lint:no-emdash", "lint:ui-jargon"],
    notes: [
      "If it names one module's kind, it is not generic — it belongs beside that module's page (see page-level-module-ui).",
    ],
  },
  {
    id: "page-level-module-ui",
    what: "a page, sheet or modal that belongs to ONE module's surface",
    keywords: ["page", "sheet", "modal", "drawer", "screen", "one module", "locations page", "scan page"],
    dir: "web/src/pages/",
    exemplar: "web/src/pages/NewBinSheet.tsx",
    why: "Naming your own module's kind on its own page is fine, so page-level UIs are exempt from the generic-component rule.",
    lints: ["lint:hooks-after-return", "lint:no-emdash", "lint:ui-jargon", "lint:jsx-comment-text"],
  },
  {
    id: "module-ui",
    what: "UI shipped BY a module (loaded through its manifest)",
    keywords: ["module ui", "module component", "ships with the module"],
    dir: "modules/<name>/src/ui/",
    exemplar: "modules/inventory/src/ui/PartsListPage.tsx",
    why: "A module owns its own UI and exports it through `ui` in the manifest; the web app imports it rather than reimplementing it.",
    lints: ["lint:isolation", "lint:hooks-after-return", "lint:ui-vocab"],
    notes: ["A module UI must never import another module — compose through the platform contract."],
  },
  {
    id: "new-module",
    what: "a whole new first-party module",
    keywords: ["new module", "connector", "add a module"],
    dir: "modules/<name>/",
    exemplar: "modules/core-locations/src/module.ts",
    why: "Band, capability-vs-domain naming and instanceability are decided BEFORE any code, because renaming touches the package, tablePrefix, every id, routes and bundles.",
    lints: ["lint:manifests", "lint:isolation", "lint:versions", "lint:ai-reach"],
    notes: ["Load the `authoring-a-module` skill first — it owns those three decisions."],
  },
  {
    id: "kernel-platform-service",
    what: "a kernel seam every module can call",
    keywords: ["platform seam", "kernel", "contract", "platform()", "shared service"],
    dir: "api/src/platform/",
    exemplar: "api/src/platform/exclusive.ts",
    why: "A capability two modules would otherwise each hand-roll belongs in the kernel, declared on the platform contract so modules reach it without importing each other.",
    lints: ["lint:isolation", "lint:background-loops"],
    notes: [
      "Declare it on `packages/platform-contract/src/index.ts` and wire it in `api/src/index.ts`; both halves or modules cannot see it.",
      "Import the db handle lazily inside the function — an eager import drags cobblr_meta into every unit test that imports an adopting file.",
    ],
  },
  {
    id: "background-loop",
    what: "a sweeper, poller or anything on a timer",
    keywords: ["sweeper", "cron", "timer", "setinterval", "poll", "background", "worker", "scheduled"],
    dir: "modules/<name>/src/ or api/src/platform/",
    exemplar: "api/src/platform/delivery-sweeper.ts",
    why: "Every api process starts these and more than one api runs against a single database, so an unguarded loop does its work twice on real data.",
    lints: ["lint:background-loops", "lint:hook-timeouts"],
    notes: [
      "Take `platform().exclusive.run(name, work)` (modules) or `runExclusive` (kernel), claim what you act on, or annotate `// SINGLE-PROCESS-SAFE: <why>`.",
      "Prefer the queue (`platform().queue`) when the work is per-item: it claims rows with `for update skip locked` and is safe by construction.",
    ],
  },
  {
    id: "migration",
    what: "a schema change",
    keywords: ["migration", "schema", "alter table", "add column", "sql"],
    dir: "modules/<name>/migrations/ or api/migrations/",
    exemplar: "modules/digifab/migrations/0034_print_rule_fired_events.sql",
    why: "More than one api version runs against a tenant database at a time, so a migration lands under the PREVIOUSLY deployed api.",
    lints: ["lint:migration-additive", "lint:jsonb-array-writes"],
    notes: [
      "Additive is invisible to the old reader; a drop/rename/retype breaks it. A genuine contraction says `-- PHASE: contract` + `-- SAFE WHEN: <what you checked>`.",
      "A jsonb ARRAY column: type its WRITE as `string` (`ColumnType<unknown[], string, string>`) so passing a JS array is a compile error, not a runtime one.",
    ],
  },
  {
    id: "entity-action",
    what: "something a person or the assistant can DO to a record",
    keywords: ["action", "invoke", "button that does something", "cobb can do", "wire target"],
    dir: "modules/<name>/src/",
    exemplar: "modules/labels/src/api/handlers.ts",
    why: "An action is the only door that both a person, a wire and the assistant can come through, so capability belongs there rather than in a bespoke route.",
    lints: ["lint:ai-reach", "lint:ai-reach-routes", "lint:ai-coverage", "lint:action-predicates"],
    notes: ["A mutating route with no action must carry `// AI-REACH: <reason>` at the route."],
  },
  {
    id: "lint",
    what: "a new repo rule",
    keywords: ["lint", "rule", "guard", "check", "enforce", "prevent"],
    dir: "scripts/",
    exemplar: "scripts/lint-background-loops.ts",
    why: "Bespoke scripts enforce invariants a general linter cannot express; there is deliberately no ESLint here.",
    lints: ["lint:placement", "lint:lints-are-wired"],
    notes: [
      "A 'one implementation only' rule is a ROW in scripts/capabilities.ts, not a new script.",
      "Add a row to scripts/placement-registry.ts saying which kind of work it governs, or lint:placement fails: enforcement may not be added without saying where it bites.",
      "Prove it RED on the real violation before you fix that violation. A lint that has never failed has never been verified.",
      "If it imports a new file of yours, add that file to scripts/publish/manifests/core.json — lint scripts ship in the public export, and one that cannot load is broken for everyone who clones it (this PR tripped exactly that).",
    ],
  },
  {
    id: "unit-test",
    what: "a test with no database",
    keywords: ["unit test", "test", "vitest", "pure test"],
    dir: "api/tests/ or beside: the file it tests, for a pure one",
    exemplar: "web/src/pages/newBinSheet.test.ts",
    why: "Pure decisions are tested where they live; anything needing a tenant database is an integration test in api/tests/.",
    lints: ["lint:hook-timeouts"],
    notes: [
      "Name it after the CONSEQUENCE, not the mechanism, and prove it red before you trust it green.",
      "Keep the db out of the import graph: a test that imports a file which eagerly imports cobblr_meta dies before it reaches its subject.",
    ],
  },
  {
    id: "e2e",
    what: "an asserting browser test or a demo walkthrough",
    keywords: ["e2e", "playwright", "browser test", "walkthrough", "screenshot"],
    dir: "e2e/",
    exemplar: "e2e/mobile-overflow.mjs",
    why: "The nightly yardstick batch runs these on the shared box; a screenshot-only script proves nothing and belongs to the demos instead.",
    lints: ["lint:ci-sink"],
    notes: [
      "Add it to scripts/run-e2e-yardsticks.sh to make it gate; otherwise nobody runs it.",
      "Seed the data the assertion needs. A sweep over an empty list passes vacuously — assert a positive control first.",
    ],
  },
  {
    id: "user-doc",
    what: "documentation a user reads",
    keywords: ["docs", "documentation", "user guide", "manual", "readme"],
    dir: "docs/",
    exemplar: "docs/design-decisions/canary-channel.md",
    why: "docs/README.md routes a change to the doc it touches; a design record explains a decision, the runbook owns how the thing actually runs.",
    lints: ["lint:docs", "lint:doc-owned-facts", "lint:no-emdash"],
    notes: [
      "Do not restate a fact another doc owns — link it. Two copies means one of them is quietly wrong.",
    ],
  },
  {
    id: "bundle",
    what: "a one-click bundle for a use case (a table with its fields, views and scan routing)",
    keywords: ["bundle", "use case", "one-click", "flagship", "preset", "quickstart", "instance for a use case"],
    dir: "web/src/lib/featured-bundles.ts",
    exemplar: "bundles/computers.json",
    why: "featured-bundles.ts is the ONE source; bundles/*.json is GENERATED from it. Editing the json directly is the drift this pair already suffered once, and lint:bundles-synced now catches it.",
    lints: ["lint:bundles-synced", "lint:bundle-schema", "lint:bundle-content", "lint:bundle-quality", "lint:bundle-id-noun", "lint:versions"],
    notes: [
      "Author the entry in web/src/lib/featured-bundles.ts, then run `npx tsx scripts/sync-bundles.ts` to regenerate bundles/<slug>.json. Never hand-edit the json.",
      "Then `npx tsx scripts/lint-bundle-content.ts --write` to record it in bundles/bundle-versions.lock.json, or lint:bundle-content fails on a new bundle.",
      "Build on the module whose OWN description fits the thing (assets = owned one by one, inventory = countable stock, machines = machines you operate). Add only the fields that module does not already carry natively.",
      "scan_keywords on the instance are what make a scan route here rather than to a neighbouring table; keep them to the thing itself, not its parts or accessories.",
      "A bundle feature is exempt from changelog.d - the manifest's own `changelog` + version bump is its entry.",
    ],
  },
  {
    id: "changelog",
    what: "the user-facing note for a change",
    keywords: ["changelog", "release note", "what changed"],
    dir: "changelog.d/",
    exemplar: "changelog.d/a-bin-from-a-photo.md",
    why: "Entries stage here and publish with the release; the /changelog page reads the directory live.",
    lints: ["lint:changelog", "lint:no-emdash"],
    notes: [
      "Read changelog.d/README.md first: frontmatter needs `type:` and `date:`, a feature also needs `docs_target:` and a `## docs` section.",
      "A feature PR also bumps the module version and updates docs; bugfixes are exempt from all three.",
    ],
  },
];
