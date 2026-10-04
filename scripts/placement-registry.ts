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
//   3. every lint named by a row, or claiming one in its record, is registered;
//   4. a NEW lint script must be claimed by a row or declared GENERAL. That is
//      the one that matters: enforcement cannot be added to this repo without
//      saying which kind of work it governs, so the map grows with the rules
//      instead of falling behind them.
//
// The rules themselves are NOT restated here. Each row names the lints that
// judge it and the tool prints their one-line rule from the lint's own header,
// so there is one copy of every rule and it lives in the thing that enforces
// it.

import { readRegistry } from "./lib/lint-durations.mjs";

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
  /** Lints that will judge this kind of file. A NEW lint claims its row in its
   *  own record instead (scripts/lint-durations/<name>.json, "rows"), so two
   *  lints claiming one row never edit this array at once (#3455); read a
   *  row's full set through lintsOf(row). */
  lints: string[];
  /** Anything that is a decision rather than a rule — pick these carefully. */
  notes?: string[];
}

export const PLACEMENT: PlacementRow[] = [
  {
    id: "bridge-installer",
    what: "a native edge bridge installer for macOS or Linux",
    keywords: ["native", "macos", "edge", "bridge", "install", "lightburn", "setup", "installer"],
    dir: "api/src/platform/",
    exemplar: "api/src/platform/edge-bridge-install.sh",
    why: "The public installer is kernel infrastructure, embedded in the API so every image can serve it before enabling a module.",
    lints: ["lint:no-file-reads-at-module-load", "lint:generated-artifact-paths"],
  },
  {
    id: "sales-order-email",
    what: "parse an order email into a sales draft",
    keywords: ["parse an order email", "sales email", "order email", "email intake"],
    dir: "modules/sales/src/",
    exemplar: "modules/sales/src/order-email.ts",
    why: "Sales owns the draft; shared email body and receipt money parsers live in platform-contract and the existing API dispatcher owns addresses and archiving.",
    lints: ["lint:no-emdash"],
  },
  {
    id: "assistant-prompt-sentence",
    what: "a sentence the assistant is told on every turn: a rule, a situational line, a consent notice",
    keywords: ["system prompt", "prompt", "prompt rule", "what cobb is told", "grounding", "current view", "consent line"],
    dir: "modules/core-ai/src/api/",
    exemplar: "modules/core-ai/src/api/system-prompt.ts",
    why: "One builder assembles the whole prompt. A caller that appends its own sentence afterwards makes a prompt only that caller sends, and the bench that measures the product is the caller that finds out last.",
    lints: ["lint:one-system-prompt", "lint:no-emdash", "lint:bench-mirrors-guards"],
    notes: [
      "Pass what the sentence needs through PromptOptions and render it inside the builder (see situationalSuffix); a pure sentence-builder gets its own file beside page-context.ts so it is testable without the router.",
      "Changing a rule changes every answer: re-run scripts/bench-action-rail.ts and put the number in the comment, the way the JSON-fallback block does.",
      "A GUARD (a pure function the turn applies to a call or a reply) goes in its own file here and must be imported by the bench too, or exempted with a reason: a guard the bench lacks makes it score a path the product no longer takes.",
    ],
  },
  {
    id: "assistant-tool",
    what: "a tool the assistant (and the MCP server) can call: its name, description and parameters",
    keywords: ["tool", "workspace tool", "assistant tool", "mcp tool", "tool description", "list_records"],
    dir: "packages/workspace-tools/src/",
    exemplar: "packages/workspace-tools/src/tools.ts",
    why: "Every tool's description is sent to the model on every turn, so a description carries only what a model needs to choose and call it; the why goes in a comment above it.",
    lints: ["lint:tool-descriptions", "lint:mcp-readme", "lint:escort-claims"],
    notes: [
      "One registry serves both in-app Cobb and the MCP server; the README lint keeps the server's table true to it.",
    ],
  },
  {
    id: "generic-web-component",
    what: "a web component that works for ANY module's records",
    keywords: ["component", "shared component", "generic", "reusable ui", "widget", "panel on every record", "record panel", "every record", "detail page section", "floor plan editor", "floor plan editor placed items"],
    dir: "web/src/components/",
    exemplar: "web/src/components/EntityAttachments.tsx",
    why: "This layer is module-agnostic: it may not name a module's entity kind, because doing so silently excludes every module added later.",
    lints: ["lint:component-kinds", "lint:hooks-after-return", "lint:no-emdash", "lint:ui-jargon", "lint:authed-image-src", "lint:noun-pluralisation", "lint:dark-mode-ember", "lint:dark-mode-tints", "lint:number-input-commits-a-number", "lint:action-outcome-shown", "lint:actions-run-through-one-door", "lint:shape-changes-run-through-one-door", "lint:sticky-under-header", "lint:fixed-chrome", "lint:phone-input-font", "lint:row-pictures-resolved", "lint:scan-doubt-from-contract", "lint:timers-die-with-their-component"],
    notes: [
      "If it names one module's kind, it is not generic — it belongs beside that module's page (see page-level-module-ui).",
    ],
  },
  {
    id: "navigation-layout",
    what: "split navigation rows declared by bundles in nav layout",
    keywords: ["split navigation rows", "nav layout", "join navigation rows", "sidebar rows", "personal navigation command in Cobb", "navigation layout preference"],
    dir: "web/src/lib/",
    exemplar: "web/src/lib/nav-order.ts",
    why: "Personal navigation layout belongs to the per-device preferences used by every navigation renderer.",
    lints: ["lint:component-kinds", "lint:hooks-after-return", "lint:no-emdash"],
  },
  {
    id: "shared-web-primitive",
    what: "a form, field or layout primitive that a SHARED package component must also reach (a field control, a field grid, a modal layout rule)",
    keywords: ["primitive", "field", "form", "grid", "packer", "layout", "control", "input", "platform-web", "custom fields panel", "shared overlay safe area", "persistent connectivity banners"],
    dir: "packages/platform-web/src/",
    exemplar: "packages/platform-web/src/fieldControl.ts",
    why: "The shared consumers (CustomFieldsPanel, FieldRenderer, Modal) live in @cobblr/platform-web, and that package cannot import web/src. A primitive put in web/src/components would be unreachable from the very panel that every record page renders, so a second copy appears there. The rule has one home where both the app and the package import it.",
    lints: ["lint:field-pack", "lint:hooks-after-return", "lint:no-emdash", "lint:ui-jargon", "lint:phone-input-font", "lint:fixed-chrome", "lint:sticky-under-header", "lint:field-pack", "lint:dark-line-reads"],
    notes: [
      "Not every generic component belongs here: only one a package component must reach. A widget only pages render is a generic-web-component in web/src/components.",
      "Pair the pure rule (a .ts file with tests) with the component that renders it (a .tsx), the way field-pack.ts and FieldPack.tsx are paired.",
    ],
  },
  {
    id: "page-level-module-ui",
    what: "a page, sheet or modal that belongs to ONE module's surface",
    keywords: ["page", "sheet", "modal", "drawer", "screen", "one module", "locations page", "scan page"],
    dir: "web/src/pages/",
    exemplar: "web/src/pages/NewBinSheet.tsx",
    why: "Naming your own module's kind on its own page is fine, so page-level UIs are exempt from the generic-component rule.",
    lints: ["lint:hooks-after-return", "lint:no-emdash", "lint:ui-jargon", "lint:jsx-comment-text", "lint:authed-image-src", "lint:noun-pluralisation", "lint:scan-card-copy"],
  },
  {
    id: "module-ui",
    what: "UI shipped BY a module (loaded through its manifest)",
    keywords: ["module ui", "module component", "ships with the module"],
    dir: "modules/<name>/src/ui/",
    exemplar: "modules/inventory/src/ui/PartsListPage.tsx",
    why: "A module owns its own UI and exports it through `ui` in the manifest; the web app imports it rather than reimplementing it.",
    lints: ["lint:isolation", "lint:hooks-after-return", "lint:ui-vocab", "lint:authed-image-src", "lint:noun-pluralisation"],
    notes: ["A module UI must never import another module — compose through the platform contract."],
  },
  {
    id: "new-module",
    what: "a whole new first-party module",
    keywords: ["new module", "connector", "add a module"],
    dir: "modules/<name>/",
    exemplar: "modules/core-locations/src/module.ts",
    why: "Band, capability-vs-domain naming and instanceability are decided BEFORE any code, because renaming touches the package, tablePrefix, every id, routes and bundles.",
    lints: ["lint:manifests", "lint:isolation", "lint:versions", "lint:ai-reach", "lint:kind-create-logs"],
    notes: ["Load the `authoring-a-module` skill first — it owns those three decisions."],
  },
  {
    id: "contract-resolver",
    what: "a pure rule in the platform contract that every surface reads (a resolver, a predicate, the context it takes)",
    keywords: ["resolver", "contract", "context", "predicate", "one rule", "platform-contract", "scan-triage", "row state", "eligibility", "readiness", "resolver context field"],
    dir: "packages/platform-contract/src/",
    exemplar: "packages/platform-contract/src/scan-triage.ts",
    why: "A rule two surfaces would otherwise each derive lives once in @cobblr/platform-contract, where the api, the web app, a module and the assistant all import it; a surface RENDERS the answer and never derives its own.",
    lints: ["lint:contract-sibling-imports", "lint:gated-state-has-a-producer", "lint:scan-doubt-from-contract", "lint:one-day-rule", "lint:public-url-one-reader"],
    notes: [
      "Every optional field on the resolver's context must be PRODUCED by a surface before it is read; a field nothing sets is coverage that is not there (lint:gated-state-has-a-producer).",
      "The surface that calls the resolver builds its context in ONE place (web/src/pages/scanViewer.ts is the shape), and a surface test takes it from there, never from a hand-built object.",
      "Pair the rule with its own unit test beside it (scan-row-state.test.ts); a contract test builds contexts by hand on purpose, a surface test may not.",
    ],
  },
  {
    id: "kernel-platform-service",
    what: "a kernel seam every module can call",
    keywords: ["platform seam", "kernel", "contract", "platform()", "shared service", "headless", "scan station", "NFC tag aliases", "station sessions"],
    dir: "api/src/platform/",
    exemplar: "api/src/platform/exclusive.ts",
    why: "A capability two modules would otherwise each hand-roll belongs in the kernel, declared on the platform contract so modules reach it without importing each other.",
    lints: ["lint:isolation", "lint:background-loops", "lint:credential-slot-kind", "lint:pg-clients-born-guarded", "lint:contract-sibling-imports"],
    notes: [
      "Declare it on `packages/platform-contract/src/index.ts` and wire it in `api/src/index.ts`; both halves or modules cannot see it.",
      "Import the db handle lazily inside the function — an eager import drags cobblr_meta into every unit test that imports an adopting file.",
    ],
  },
  {
    id: "image-op",
    what: "a pipeline over a photo's pixels: a crop, a trim, a rotate, a read of a region",
    keywords: ["crop", "extract", "sharp", "pixels", "image", "photo", "rotate", "trim", "orientation", "exif"],
    dir: "modules/core-scan/src/services/",
    exemplar: "modules/core-scan/src/services/image-ops.ts",
    why: "Every box a model or a person draws is drawn on the picture as displayed, and a phone stores its raster a quarter turn from that; uprightBytes (trim-margins.ts) is the one place the turn is baked in, so every cut reads the same frame.",
    lints: ["lint:extract-upright", "lint:extract-upright"],
    notes: [
      "Start from uprightBytes(input) and cut its bytes; never sharp(raw).extract(...). A split of a phone photo once handed each child a patch of the table beside the boxes (2026-09-13).",
      "Look at the cut before trusting it: cropBytes refuses a sliver, a near-whole frame and a flat patch with a reason; write nothing for a refusal.",
    ],
  },
  {
    id: "boot-reconcile",
    what: "a self-heal that repairs workspaces created before your change",
    keywords: ["self heal", "selfheal", "reconcile", "backfill", "heal shim", "boot", "existing workspaces", "older workspaces", "one-shot"],
    dir: "api/src/platform/",
    exemplar: "api/src/platform/reconcile-contributed-fields.ts",
    why: "Signup only enables and migrates what existed the day a workspace was made, so anything an OLDER workspace also needs is silently missing there and the platform, not the user, has to close that gap.",
    lints: ["lint:heal-shims", "lint:test-support-doors-scoped", "lint:boot-pass-born-with"],
    notes: [
      "Wire it into `boot()` in api/src/index.ts, in the existing reconcile chain.",
      "Head the file with `DONE WHEN: <the checkable condition>` for a one-shot, or `PERMANENT RECONCILE`. Delete a one-shot once its condition reads true on prod, staging and dev.",
      "Cheap on the happy path (one pre-loaded cobblr_meta read, no tenant pool for a workspace that is already fine), per-row try/catch so one workspace never blocks the rest, and `evictTenantPool` in a finally if you did open one.",
      "Put the DECISION in a pure exported function and call it from the sweep, so a test can assert the rule without a database.",
    ],
  },
  {
    id: "background-loop",
    what: "a sweeper, poller or anything on a timer",
    keywords: ["sweeper", "cron", "timer", "setinterval", "poll", "background", "worker", "scheduled", "low stock notification", "notification digest"],
    dir: "modules/<name>/src/ or api/src/platform/",
    exemplar: "api/src/platform/delivery-sweeper.ts",
    why: "Every api process starts these and more than one api runs against a single database, so an unguarded loop does its work twice on real data.",
    lints: ["lint:background-loops", "lint:hook-timeouts", "lint:dispatch-not-per-row", "lint:tenant-sweep-registered"],
    notes: [
      "Take `platform().exclusive.run(name, work)` (modules) or `runExclusive` (kernel), claim what you act on, or annotate `// SINGLE-PROCESS-SAFE: <why>`.",
      "Prefer the queue (`platform().queue`) when the work is per-item: it claims rows with `for update skip locked` and is safe by construction.",
      "Collect lines in the loop and notify ONCE after it. A stocked workspace turns one dispatch per row into a stream of DMs; the per-row EVENT is what keeps the detail.",
    ],
  },
  {
    id: "migration",
    what: "a schema change",
    keywords: ["migration", "platform migration", "schema", "alter table", "add column", "sql"],
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
    lints: ["lint:ai-reach", "lint:ai-reach-routes", "lint:ai-coverage", "lint:action-predicates", "lint:action-copy-no-internal-nouns", "lint:list-args-take-arrays"],
    notes: ["A mutating route with no action must carry `// AI-REACH: <reason>` at the route."],
  },
  {
    id: "side-panel-door",
    what: "a button that opens the side panel (Ask Cobb, Discussion) about a record",
    keywords: ["side panel", "rail", "discussion tab", "discuss", "ask cobb", "open the panel", "context chip", "about a record"],
    dir: "packages/platform-web/src/",
    exemplar: "packages/platform-web/src/open-discussion.ts",
    why: "The panel cannot tell which record a modal is showing (a modal leaves the URL alone), so a door says what it is about: the record goes into the one context the Ask Cobb and Discussion chips both read.",
    lints: [],
    notes: [
      "Discussion: openDiscussion({ record }), record or null. Ask Cobb: publishRowSelection then cobblr:open-chat, as AskCobbAbout does.",
    ],
  },
  {
    id: "action-readback",
    what: "what a confirm card says before an action runs: its title and the lines under it",
    keywords: ["confirm card", "readback", "proposal card", "card wording", "planner", "plan", "what cobb proposes", "confirm"],
    dir: "beside: the action's handler (registerPlanner next to its run handler)",
    exemplar: "api/src/platform/platform-action-handlers.ts",
    why: "A card reads the action's planner; with none it falls back to the action's label and its argument labels, which are written for the assistant to fill in, so a person confirming a change reads help text instead of what will happen.",
    lints: [],
    notes: [
      "Say what changes in the person's words (\"Turn off the Yarn feature\"), then what stays and what goes. api/tests/a-confirm-card-reads-its-arguments-as-words.test.ts holds the fallback.",
    ],
  },
  {
    id: "outside-service-adapter",
    what: "an adapter that talks to an outside app or service: a document library, a game library, a machine manager, any third-party API",
    keywords: ["adapter", "outside app", "outside service", "third-party", "third party", "external api", "integration", "connect to", "sync with", "services", "library"],
    dir: "modules/<name>/src/",
    exemplar: "modules/core-documents/src/paperless.ts",
    why: "A Services adapter is reached directly or through a person's bridge without knowing which: every request goes through ctx.fetch, and the credential lives in the Services connection, never in a job's input, output or log.",
    lints: ["lint:credential-slot-kind", "lint:driver-fetch-has-timeout"],
    notes: [
      "Declare the capabilities in the platform contract (see @cobblr/platform-contract/documents) so a second adapter (modules/core-documents/src/romm.ts) answers the same calls.",
      "An outside app that rings back is an api-route (the inbound webhook); a pass that matches its items to records is a sweeper.",
    ],
  },
  {
    id: "api-route",
    what: "an HTTP route on a module or the kernel",
    keywords: ["route", "endpoint", "router.get", "router.post", "express", "handler", "url", "path", "webhook", "inbound", "doorbell", "callback"],
    dir: "modules/<name>/src/api/ or api/src/routes/",
    exemplar: "modules/core-scan/src/api/inbox.ts",
    why: "Express matches in registration order: a literal path declared after a parameter route on the same prefix is never reached, and the client gets a 400 that nothing reports (the session theme was dead this way for weeks).",
    lints: ["lint:route-shadowing", "lint:announce-routes-home", "lint:api-client-reachable", "lint:scan-triage-columns", "lint:scan-door-intake", "lint:refusal-carries-blocked", "lint:capability-gates-grantable", "lint:test-doors-gated", "lint:declared-endpoints-served"],
    notes: [
      "Register literal paths (/inbox/session-theme) ABOVE parameter paths (/inbox/:id) in the same router.",
      "A route's client method in web/src/lib/api.ts is not a feature until something on screen calls it: lint:api-client-reachable refuses a method with no caller (the catalog crop sat reachable-by-curl-only for a month).",
      "A route that announce()s about somebody's ticket passes `originGuildId` from the ticket's origin_ref, or the notice lands in the operator's own server where the people in that conversation cannot see it. A DM has no guild: say so with `// no-origin-guild: <reason>`.",
    ],
  },
  {
    id: "dev-script",
    what: "a shell script agents run on the dev Mac",
    keywords: ["shell script", "bash", "worktree script", "merge script", "hook", "pre-push"],
    dir: "scripts/ (git hooks in scripts/git-hooks/)",
    exemplar: "scripts/merge-pr.sh",
    why: "The same file runs on macOS (bash 3.2, BSD sed) and on the Linux CI box; a construct that is fine on one aborts on the other, after part of the work has already printed as done.",
    lints: ["lint:bash-portable", "lint:portable-sed", "lint:sigpipe", "lint:deploy-state-in-flow", "lint:shell-lib-git-cwd", "lint:tsbuildinfo-not-shared", "lint:nightly-cut-clock", "lint:empty-array-under-set-u", "lint:scripts-typecheck", "lint:fetch-retry", "lint:porcelain-parse", "lint:alert-lib-sync", "lint:lint-durations", "lint:no-pattern-kill", "lint:forgejo-api-base", "lint:git-pathspec-glob", "lint:workstation-tmp-per-run"],
    notes: [
      "Prose (commit messages, PR bodies) goes through a FILE, never a quoted shell string.",
      "Linux-only scripts opt out with `# gnu-sed: <reason>`; that one line covers both sed and bash rules.",
      "merge-pr.sh and new-worktree.sh must PRINT where the channels are (lib/deploy-state.sh): everyone here works from a stale idea of what the nightly is, and a detour to check it is one nobody takes mid-task.",
      "Worktrees SHARE node_modules, so nothing worktree-specific belongs there: a tsBuildInfoFile under it makes tsc -b trust another worktree timestamps and pass on a broken tree.",
      "A .ts script here is TYPECHECKED like the rest of the repo (lint:scripts-typecheck) - `pnpm typecheck` walks the workspaces and scripts/ is not one, so this is the gate that covers it.",
      "A lib in scripts/lib/ is sourced by callers it does not control, so it must not read git from $PWD: scope with `git -C \"$repo\"` resolved from BASH_SOURCE, or say why not with `# cwd-repo: <reason>`.",
    ],
  },
  {
    id: "agent-instructions",
    what: "the rules every agent loads at start: the root CLAUDE.md",
    keywords: ["claude.md", "agent rules", "agent instructions", "hard rule", "what agents load"],
    dir: "CLAUDE.md (the long form is docs/architecture/platform-spec.md)",
    exemplar: "CLAUDE.md",
    why: "Every agent reads CLAUDE.md at every start and every compaction. At 63k characters it cost each one about 12k tokens, ran past the tool's 40k warning, and made a local-model agent slow to start (2026-10-02).",
    lints: [],
    notes: [
      "A rule goes in CLAUDE.md as one short line with its why; the history, the incident and the long explanation go in docs/architecture/platform-spec.md under the rule's section, and the line points there.",
      "Cite a rule by its spec section (\"platform-spec.md §14.6\"), never by a CLAUDE.md section number: CLAUDE.md has no numbers to keep stable.",
    ],
  },
  {
    id: "api-cli",
    what: "a command run INSIDE the api container (docker exec node dist/cli/<name>.js) with the api's env and database",
    keywords: ["cli", "docker exec", "dist/cli", "on the box", "operator command", "view-as"],
    dir: "api/src/cli/",
    exemplar: "api/src/cli/view-as.ts",
    why: "Its stdout and stderr are pipes, and on a pipe a stream write is asynchronous: a process.exit() right after it drops everything past ~64 KiB, and the JSON arrives cut mid-string with no error (view-as list, 2026-09-08). The exit is still needed because the meta pool keeps the process alive.",
    lints: ["lint:cli-flush-before-exit"],
    notes: [
      "Write output with fs.writeSync(1, ...) / writeSync(2, ...), never process.stdout.write / process.stderr.write / console.log, in any file that also calls process.exit.",
      "The same lint holds the CI harnesses (any scripts/ file importing lib/parallel.mjs): they print a child's whole captured output into the job's `| tee`, and the failing run's log was the one cut at 64 KiB (#3167). There, drop the exit call and set process.exitCode.",
      "Being inside the container IS the authority: a CLI here needs no API token, and must not mint one. Keep it read-only unless the owner has decided otherwise.",
    ],
  },
  {
    id: "ci-workflow",
    what: "a Forgejo Actions workflow or a CI job step",
    keywords: ["workflow", "ci.yml", "forgejo actions", "runs-on", "job", "ci step"],
    dir: ".forgejo/workflows/",
    exemplar: ".forgejo/workflows/ci.yml",
    why: "Forgejo keeps no job logs and parses each job on its own: a step that ships no log is unreadable after the fact, a label nobody carries never runs, and a YAML anchor across jobs invalidates the whole file.",
    lints: ["lint:ci-sink", "lint:ci-runner-labels", "lint:ci-lanes", "lint:workflow-yaml", "lint:latest-monotonic", "lint:ci-pr-any-base", "lint:forgejo-pagination", "lint:main-runs-complete", "lint:catalog-replay", "lint:ci-exit-read-under-set-e", "lint:dockerfile-copies-ship", "lint:slot-pairs-are-wired", "lint:ci-every-commit-has-a-status"],
    notes: [
      "A step's log is a pipe (`| tee`): a harness that prints a child's captured output must end by process.exitCode, never process.exit(), or the failing run's log stops at 64 KiB with no failing test in it (#3167; lint:cli-flush-before-exit).",
      "The `test` and `test-full` jobs are one job in two places; edit the gate, copy its env+steps over the tracker.",
      "No YAML anchors or merge keys across jobs: Forgejo's job parser splits first and resolves second.",
      "Every run ships its log to the sink (scripts/ci-log.sh reads it); `?limit=` needs `&page=1` on this API.",
    ],
  },
  {
    id: "lint",
    what: "a new repo rule",
    keywords: ["lint", "rule", "guard", "check", "enforce", "prevent"],
    dir: "scripts/",
    exemplar: "scripts/lint-background-loops.ts",
    why: "Bespoke scripts enforce invariants a general linter cannot express; there is deliberately no ESLint here.",
    lints: ["lint:placement", "lint:lints-are-wired", "lint:scripts-typecheck", "lint:shipped-script-imports", "lint:corpus-known-red-live", "lint:dns-probe-unpinned", "lint:tick-problems-keyed", "lint:box-cron-offsets", "lint:no-inline-script-quotes"],
    notes: [
      "Start with scripts/new-lint.sh <slug> --row <row> --rule \"<sentence>\": it writes the file from scripts/templates/lint.template.ts and its record scripts/lint-durations/<slug>.json (the command CI runs, the row it claims, a first time), and runs it once (skill: writing-a-lint). Nothing shared is edited, so two branches adding a lint never conflict.",
      "A 'one implementation only' rule is a ROW in scripts/capabilities.ts, not a new script.",
      "Claim the row of the work it governs in its record (\"rows\", which the scaffold fills from --row), or lint:placement fails: enforcement may not be added without saying where it bites.",
      "Prove it RED on the real violation before you fix that violation. A lint that has never failed has never been verified.",
      "If it imports a new file of yours, add that file to scripts/publish/manifests/core.json — lint scripts ship in the public export, and one that cannot load is broken for everyone who clones it (this PR tripped exactly that).",
    ],
  },
  {
    id: "integration-test",
    what: "an api integration test (boots the api, talks to Postgres)",
    keywords: ["integration test", "api test", "api/tests", "supertest", "signupFreshOrg"],
    dir: "api/tests/",
    exemplar: "api/tests/core-scan.test.ts",
    why: "One suite, 389 files, 4 minutes: a test that does not say what it covers runs on every change, and one that says it wrong never runs on the change that breaks it.",
    lints: ["lint:test-affects", "lint:test-durations", "lint:test-budget-covers-signup", "lint:wall-clock-assertions"],
    notes: [
      "First line: `// affects: <module>, <module>` or `always` or `kernel`. `node scripts/test-affects.mjs --infer <file>` proposes one from the routes the test hits.",
      "Test the consequence you fear, not the mechanism you built; name it after what it costs when wrong (docs/architecture/platform-spec.md §14.1a).",
      "Under ~5s if it belongs in api/tests/smoke.list; a slow smoke test is a tax on every PR.",
    ],
  },
  {
    id: "unit-test",
    what: "a test with no database",
    keywords: ["unit test", "test", "vitest", "pure test"],
    dir: "api/tests/ or beside: the file it tests, for a pure one",
    exemplar: "web/src/pages/newBinSheet.test.ts",
    why: "Pure decisions are tested where they live; anything needing a tenant database is an integration test in api/tests/.",
    lints: ["lint:hook-timeouts", "lint:test-path-starts-with-its-own-bin", "lint:test-timeout-worn", "lint:web-image-reads-what-it-copies", "lint:hook-returns-nothing"],
    notes: [
      "Name it after the CONSEQUENCE, not the mechanism, and prove it red before you trust it green.",
      "Keep the db out of the import graph: a test that imports a file which eagerly imports cobblr_meta dies before it reaches its subject.",
    ],
  },
  {
    id: "e2e",
    what: "an asserting browser test or a demo walkthrough",
    keywords: ["e2e", "playwright", "browser test", "walkthrough", "screenshot", "drives the web app in a browser", "assertions", "phone and desktop", "pass/fail table", "check a page", "verify a ui change"],
    dir: "e2e/",
    exemplar: "e2e/mobile-overflow.mjs",
    why: "The nightly yardstick batch runs these on the shared box; a screenshot-only script proves nothing and belongs to the demos instead.",
    lints: ["lint:ci-sink", "lint:driver-hooks-live", "lint:doc-shots-prod-look", "lint:scan-fixture-category", "lint:materialize-reads-its-answer", "lint:e2e-visible-probe-filters-first", "lint:shot-guard"],
    notes: [
      "Checking a UI change before a pull request needs no new script: `node scripts/walk.mjs` (one-off flags, or a JSON spec with steps) asserts a page at 390 and 1440 px and prints a pass/fail table. Write an e2e/ script only for a check that must stay and gate.",
      "Add it to scripts/run-e2e-yardsticks.sh to make it gate; otherwise nobody runs it.",
      "Seed the data the assertion needs. A sweep over an empty list passes vacuously — assert a positive control first.",
      "Reach a control by a hook the product declares (data-testid, a placeholder), never by its tag or styling: the hook is checked against the source at PR time, the tag is not.",
    ],
  },
  {
    id: "guided-tour",
    what: "a narrated recording of the product: a guided tour or a marketing clip",
    keywords: ["tour", "guided", "video", "recording", "kiosk", "clip", "narrat", "webm", "poster"],
    dir: "kiosk/",
    exemplar: "kiosk/guided-yarn.mjs",
    why: "A recording is shown to people, not read by a machine: a stale step films the wrong product and looks fine. The yarn tour is the quality floor (kiosk/GOLDEN.md) and the nightly records it.",
    lints: ["lint:kiosk-golden", "lint:driver-hooks-live", "lint:driver-hooks-live"],
    notes: [
      "Read docs/walkthroughs/guided-video-recording.md first; every trap in it cost a take.",
      "Drive the product by hooks it declares (data-testid, placeholders) and wrap every optional beat in softly(): a miss is a [skip] the nightly fails on, not sixteen seconds of dead air.",
      "Never call a take good off the run log. scripts/nightly-tour-take.sh fetches the night's take and lays out its frames; look at them.",
    ],
  },
  {
    id: "user-doc",
    what: "documentation a user reads",
    keywords: ["docs", "documentation", "user guide", "manual", "readme"],
    dir: "docs/",
    exemplar: "docs/design-decisions/canary-channel.md",
    why: "docs/README.md routes a change to the doc it touches; a design record explains a decision, the runbook owns how the thing actually runs.",
    lints: ["lint:docs", "lint:doc-owned-facts", "lint:no-emdash", "lint:doc-status-honest", "lint:walkthrough-twins"],
    notes: [
      "Do not restate a fact another doc owns — link it. Two copies means one of them is quietly wrong.",
    ],
  },
  {
    id: "bundle",
    what: "a one-click bundle for a use case (a table with its fields, views and scan routing)",
    keywords: ["bundle", "optional bundle integration", "use case", "one-click", "flagship", "preset", "quickstart", "instance for a use case"],
    dir: "web/src/lib/featured-bundles.ts",
    exemplar: "bundles/computers.json",
    why: "featured-bundles.ts is the ONE source; bundles/*.json is GENERATED from it. Editing the json directly is the drift this pair already suffered once, and lint:bundles-synced now catches it.",
    lints: ["lint:bundles-synced", "lint:bundle-schema", "lint:bundle-content", "lint:bundle-quality", "lint:bundle-id-noun", "lint:bundle-keyword-collisions", "lint:versions", "lint:platform-owned-roles", "lint:bundle-fields-on-own-kinds", "lint:identifier-fields-declared", "lint:view-group-by-bare"],
    notes: [
      "Author the entry in web/src/lib/featured-bundles.ts, then run `npx tsx scripts/sync-bundles.ts` to regenerate bundles/<slug>.json. Never hand-edit the json.",
      "Then `npx tsx scripts/lint-bundle-content.ts --write` to record it in bundles/bundle-versions.lock.json, or lint:bundle-content fails on a new bundle.",
      "Build on the module whose OWN description fits the thing (assets = owned one by one, inventory = countable stock, machines = machines you operate). Add only the fields that module does not already carry natively.",
      "scan_keywords on the instance are what make a scan route here rather than to a neighbouring table; keep them to the thing itself, not its parts or accessories.",
      "A keyword never names what ANOTHER bundle is (its instance name or noun): the matchmaker and the Build-page suggester both read that vocabulary, and a shared noun routes wrong in one and means nothing in the other. lint:bundle-keyword-collisions.",
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
    lints: ["lint:changelog", "lint:no-emdash", "lint:changelog-names-ui"],
    notes: [
      "Read changelog.d/README.md first: frontmatter needs `type:` and `date:`, a feature also needs `docs_target:` and a `## docs` section.",
      "A feature PR also bumps the module version and updates docs; bugfixes are exempt from all three.",
    ],
  },
  {
    id: "selfhost-deploy",
    what: "a compose file, .env example or helper script that somebody self-hosting downloads and runs",
    keywords: [
      "self-host",
      "selfhost",
      "compose",
      "docker-compose",
      "env example",
      "watchtower",
      "autoupdate",
      "updater",
      "upgrade",
      "standalone stack",
    ],
    dir: "deploy/selfhost/standalone/",
    exemplar: "deploy/selfhost/standalone/docker-compose.yml",
    why: "Self-hosters curl these straight from the public mirror, so a change here lands on machines nobody here can log into or fix.",
    lints: ["lint:autoupdate-warns-env-drift", "lint:backup-guards", "lint:env-booleans-are-loud", "lint:csp-no-inline-scripts"],
    notes: [
      "The README beside the compose file is the only documentation most self-hosters read. If a change needs explaining, explain it there.",
      "An updater re-creates a container by cloning the old environment, so it never re-reads .env. Anything shipping one has to say so and point at check-env-drift.sh.",
    ],
  },
  {
    id: "release-tooling",
    what: "a script or workflow step that cuts, names, announces or verifies a release",
    keywords: [
      "release",
      "nightly",
      "cut",
      "promote",
      "snapshot tag",
      "changelog publisher",
      "announce",
      "calver",
    ],
    dir: "scripts/",
    exemplar: "scripts/release-daily.sh",
    why: "One commit becomes several artifacts on several surfaces, so anything naming or timing a release has to agree with the rest of that chain rather than be locally correct.",
    lints: ["lint:one-release-clock", "lint:ci-sink", "lint:oci-labels", "lint:node-resolves", "lint:test-imports-script", "lint:census-on-every-exit"],
    notes: [
      "A nightly's date is an EDITORIAL label read from the local day, not UTC. The banner, the changelog post, the image snapshot tag and the coupling census all have to name the same night.",
      "Two clocks that are each internally consistent will not alert. That is why the rule spans both files instead of living in either.",
    ],
  },
];

/** Every registered lint and its command, from the lints' own records. */
export function registeredCommands(): Record<string, string> {
  return Object.fromEntries(readRegistry().map((l: { name: string; run: string }) => [l.name, l.run]));
}

/** The lints that judge a row: the ones its array names, and every lint whose
 *  own record claims the row. The records are where a new lint's claim lives,
 *  so this is the only correct way to read a row's lints. */
export function lintsOf(row: PlacementRow): string[] {
  const claimedHere = readRegistry()
    .filter((l: { rows: string[] }) => l.rows.includes(row.id))
    .map((l: { name: string }) => l.name);
  return [...new Set([...row.lints, ...claimedHere])];
}

/** How well a row answers a question, in the words someone typed. */
export function placementScore(row: PlacementRow, q: string): number {
  const hay = `${row.id} ${row.what} ${row.keywords.join(" ")}`.toLowerCase();
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let n = 0;
  for (const w of words) if (hay.includes(w)) n += 1;
  for (const k of row.keywords) if (q.toLowerCase().includes(k)) n += 2;
  return n;
}

/** The rows that answer a question, best first. */
export function rankPlacement(q: string): PlacementRow[] {
  return PLACEMENT.map((r) => ({ r, n: placementScore(r, q) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.r);
}
