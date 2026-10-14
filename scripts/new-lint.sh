#!/usr/bin/env bash
# Scaffold a new repo lint: the file and its record, in one step, so a new rule
# cannot be half-wired.
#
#   scripts/new-lint.sh <slug> --row <placement-row-id> --rule "<one sentence>" \
#       [--incident "<what happened, when>"] [--roots "api/src,modules"] [--fix "<hint>"]
#
#   scripts/new-lint.sh --rows          list the placement rows a lint can claim
#
# What it does, and why each part is here:
#   1. scripts/lint-<slug>.ts from scripts/templates/lint.template.ts. The first
#      sentence of the header IS the rule `pnpm run where` prints, so it is a
#      required argument rather than a placeholder to forget.
#   2. scripts/lint-durations/<slug>.json, the lint's RECORD: the command that
#      runs it, the placement row that claims it, and its first quiet time.
#      scripts/run-lints.mjs discovers lints from these records and
#      lint:placement reads the claim from it. It used to be a line in
#      package.json plus an entry appended to the row's array in
#      scripts/placement-registry.ts, so any two branches adding a lint
#      conflicted in both files by construction (#3455). Now a new lint is two
#      NEW files and touches nothing shared.
#   4. runs the new lint once. The scaffold passes with no rule written, which
#      proves the file loads; the rule is yours to write, and to PROVE RED on
#      the real violation before you fix that violation.
#
# Written after the same four steps were re-derived by reading two other lints,
# package.json and the registry, for a lint that took ten minutes to write and
# thirty to register (2026-09-08).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--rows" ]; then
  node -e '
    const s = require("fs").readFileSync("scripts/placement-registry.ts", "utf8");
    for (const m of s.matchAll(/\n    id: "([^"]+)",\n    what: "([^"]+)"/g)) console.log(`  ${m[1].padEnd(26)} ${m[2]}`);
  '
  exit 0
fi

SLUG="${1:-}"; shift || true
ROW=""; RULE=""; INCIDENT="(say what happened, and when)"; ROOTS="api/src,modules,web/src"; FIX="Fix the violation; a genuine exception opts out with an annotation that carries its reason."
while [ $# -gt 0 ]; do
  case "$1" in
    --row) ROW="$2"; shift 2;;
    --rule) RULE="$2"; shift 2;;
    --incident) INCIDENT="$2"; shift 2;;
    --roots) ROOTS="$2"; shift 2;;
    --fix) FIX="$2"; shift 2;;
    *) echo "new-lint: unknown argument $1" >&2; exit 2;;
  esac
done

die() { echo "new-lint: $*" >&2; exit 2; }
[ -n "$SLUG" ] || die "usage: scripts/new-lint.sh <slug> --row <row-id> --rule \"<one sentence>\"  (or --rows)"
[[ "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "slug must be kebab-case: $SLUG"
[ -n "$ROW" ] || die "--row <placement-row-id> is required (scripts/new-lint.sh --rows lists them)"
[ -n "$RULE" ] || die "--rule \"<one sentence>\" is required: it is what 'pnpm run where' prints for this lint"
case "$RULE" in *"—"*) die "the rule carries an em dash; lint:no-emdash will refuse it";; esac
FILE="scripts/lint-$SLUG.ts"
[ ! -e "$FILE" ] || die "$FILE already exists"
[ ! -e "scripts/lint-durations/$SLUG.json" ] || die "lint:$SLUG is already registered (scripts/lint-durations/$SLUG.json)"
grep -q "    id: \"$ROW\"," scripts/placement-registry.ts || die "no placement row with id \"$ROW\" (scripts/new-lint.sh --rows)"
if [[ "$RULE" == *" only "* || "$RULE" == *"one implementation"* || "$RULE" == *"exactly one"* ]]; then
  echo "new-lint: NOTE the rule reads like 'one implementation only'. That is a ROW in scripts/capabilities.ts, not a script (docs/design-decisions/capability-registry.md). Continuing anyway."
fi

# 1. the file, from the template
ROOTS_TS="$(printf '%s' "$ROOTS" | sed 's/,/", "/g')"
node - "$SLUG" "$RULE" "$INCIDENT" "$ROOTS_TS" "$FIX" "$FILE" <<'NODE'
const fs = require("fs");
const [slug, rule, incident, roots, fix, file] = process.argv.slice(2);
let t = fs.readFileSync("scripts/templates/lint.template.ts", "utf8");
const sub = (k, v) => { t = t.split(k).join(v); };
// The template sits in scripts/templates/; the lint it becomes sits in scripts/.
sub('from "../lib/', 'from "./lib/');
sub("__RULE__", rule); sub("__INCIDENT__", incident); sub("__ROOTS__", roots); sub("__FIX_HINT__", fix.replace(/"/g, '\\"')); sub("__SLUG__", slug);
fs.writeFileSync(file, t);
NODE
chmod +x "$FILE"

# 4. it must load and pass empty, and that run is its first recorded time.
#    The budget judges a lint it has never heard of at the snapshot median and
#    fails it at the ceiling with no re-measure, so an unrecorded lint is a
#    trap for whoever runs CI next. Recorded HERE, at twice this run (a dev box
#    is not a quiet CI runner), in its own file — one file per lint, so two
#    people scaffolding two lints never conflict (#3447). CI's own clock
#    replaces the number later: node scripts/lint-durations-record-missing.mjs
# Run exactly as the runner will (lib/lint-command.mjs): plain node, or tsx on
# a Node too old to strip types.
RUN_CMD=$(FILE="$FILE" node --input-type=module -e 'const { lintCommand } = await import("./scripts/lib/lint-command.mjs"); process.stdout.write(lintCommand("node " + process.env.FILE));')
if ! PATH="$PWD/node_modules/.bin:$PATH" bash -c "$RUN_CMD"; then die "the scaffold did not run clean; that is a bug in the template, not in your rule"; fi
# The SECOND run is the one worth timing: the first pays a cold start, which
# is not what the lint costs in CI, and a 30s estimate would be a hole in the
# budget rather than a baseline.
START_MS=$(node -e 'process.stdout.write(String(Date.now()))')
PATH="$PWD/node_modules/.bin:$PATH" bash -c "$RUN_CMD" >/dev/null 2>&1 || true
END_MS=$(node -e 'process.stdout.write(String(Date.now()))')
START_MS="$START_MS" END_MS="$END_MS" SLUG="$SLUG" ROW="$ROW" node --input-type=module -e "
  const { registerLint } = await import('./scripts/lib/lint-durations.mjs');
  const took = Number(process.env.END_MS) - Number(process.env.START_MS);
  const { CEILING_MS } = await import('./scripts/lib/lint-budget.mjs');
  // Capped at the budget's own ceiling: a loaded dev box can time a trivial
  // lint at ten seconds, and doubling that would be a hole rather than a
  // baseline. The first CI measurement replaces it either way.
  const guess = Math.min(CEILING_MS, Math.max(500, took * 2));
  const p = registerLint('lint:' + process.env.SLUG, { run: 'node scripts/lint-' + process.env.SLUG + '.ts', rows: [process.env.ROW] }, guess, 'scaffolded by new-lint.sh at twice a local run (a shared box); replaced from its first CI measurement');
  console.log('new-lint: registered ' + p.replace(process.cwd() + '/', ''));
" || die "could not write the lint's record"

cat <<MSG

new-lint: scaffolded lint:$SLUG
  file       $FILE
  record     scripts/lint-durations/$SLUG.json  (its command, row "$ROW", a first time)

Next, in this order:
  1. Write check() in $FILE. Keep ROOTS as narrow as the rule.
  2. Prove it RED on the real violation:   pnpm lint $SLUG
  3. Fix the violation, run it again, green.
  4. pnpm lint placement && pnpm lint lints-are-wired && pnpm lint no-emdash
  5. If it imports a new file of yours, add that file to scripts/publish/manifests/core.json.
  6. Its quiet time is ALREADY RECORDED, in its record, at twice this
     scaffold's own run. Nothing to do by hand. CI's own clock
     replaces that estimate the first time the lint runs there:
     node scripts/lint-durations-record-missing.mjs
MSG
