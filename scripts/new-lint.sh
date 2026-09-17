#!/usr/bin/env bash
# Scaffold a new repo lint: the file, its package.json entry, and its claim in
# the placement registry, in one step, so a new rule cannot be half-wired.
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
#   2. "lint:<slug>" in package.json. scripts/run-lints.mjs discovers lints from
#      there and lint:lints-are-wired fails a lint file nothing registers; two
#      lints were once found that had never run (2026-07-30).
#   3. the row in scripts/placement-registry.ts names the new lint, or
#      lint:placement refuses it: enforcement may not be added without saying
#      which kind of work it governs.
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
grep -q "\"lint:$SLUG\"" package.json && die "package.json already has lint:$SLUG"
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
sub("__RULE__", rule); sub("__INCIDENT__", incident); sub("__ROOTS__", roots); sub("__FIX_HINT__", fix.replace(/"/g, '\\"')); sub("__SLUG__", slug);
fs.writeFileSync(file, t);
NODE
chmod +x "$FILE"

# 2. package.json: after the last lint:* entry, keeping the file valid JSON
node - "$SLUG" <<'NODE'
const fs = require("fs");
const slug = process.argv[2];
const src = fs.readFileSync("package.json", "utf8");
const lines = src.split("\n");
let last = -1;
lines.forEach((l, i) => { if (/^    "lint:[^"]+": /.test(l)) last = i; });
if (last < 0) { console.error("new-lint: no lint:* entries found in package.json"); process.exit(2); }
// If the last lint entry is also the last key of "scripts" it has no trailing
// comma; the new line then takes its place as last key, comma-less.
const wasLastKey = !lines[last].trim().endsWith(",");
if (wasLastKey) lines[last] = lines[last] + ",";
lines.splice(last + 1, 0, `    "lint:${slug}": "tsx scripts/lint-${slug}.ts"${wasLastKey ? "" : ","}`);
const out = lines.join("\n");
JSON.parse(out);
fs.writeFileSync("package.json", out);
NODE
node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))' || die "package.json is no longer valid JSON; revert it (git checkout package.json)"

# 3. the placement row's lints array
node - "$SLUG" "$ROW" <<'NODE'
const fs = require("fs");
const [slug, row] = process.argv.slice(2);
let s = fs.readFileSync("scripts/placement-registry.ts", "utf8");
const at = s.indexOf(`    id: "${row}",`);
const lintsAt = s.indexOf("    lints: [", at);
const close = s.indexOf("]", lintsAt);
if (at < 0 || lintsAt < 0 || close < 0) { console.error("new-lint: could not find the lints array of row " + row); process.exit(2); }
const before = s.slice(lintsAt, close);
const sep = before.trim().endsWith("[") ? "" : ", ";
s = s.slice(0, close) + `${sep}"lint:${slug}"` + s.slice(close);
fs.writeFileSync("scripts/placement-registry.ts", s);
NODE

# 4. it must load and pass empty
if ! npx tsx "$FILE"; then die "the scaffold did not run clean; that is a bug in the template, not in your rule"; fi

cat <<MSG

new-lint: scaffolded lint:$SLUG
  file       $FILE
  registered package.json  ->  "lint:$SLUG"
  claimed    scripts/placement-registry.ts  row "$ROW"

Next, in this order:
  1. Write check() in $FILE. Keep ROOTS as narrow as the rule.
  2. Prove it RED on the real violation:   pnpm run lint:$SLUG
  3. Fix the violation, run it again, green.
  4. pnpm run lint:placement && pnpm run lint:lints-are-wired && pnpm run lint:no-emdash
  5. If it imports a new file of yours, add that file to scripts/publish/manifests/core.json.
  6. Record its quiet time BY HAND in scripts/lint-durations.json before its first CI run:
     run it twice on an idle box, take the larger, double it, and add
     "lint:$SLUG": <ms> plus a note in "source" ("added by hand at twice a quiet
     dev-box time (<date>), to be replaced from its first CI run"). The budget
     (scripts/lib/lint-budget.mjs) fails a lint it has never heard of on the first
     measurement that crosses the ceiling, with no second look; a recorded quiet
     time is what earns it the re-measure. CI replaces the number later:
     node scripts/lint-durations-record-missing.mjs
MSG
