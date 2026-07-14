#!/usr/bin/env tsx
// jsonb-merge lint — a shared JSON bag has MANY writers, so an UPDATE that
// REPLACES one destroys every key it didn't know about.
// (docs/design-decisions/scan-inbox-pipeline.md §"the metadata bag has many writers")
//
//   npx tsx scripts/lint-jsonb-merge.ts        (npm run lint:jsonb-merge)
//
// THE RULE: an UPDATE whose value for a JSON column is built in JS
// (`sql`…::jsonb`` or a bare `JSON.stringify(…)`) must READ that same column in
// its own expression — i.e. merge DB-side:
//
//   ✅ suggested_metadata: sql`coalesce(suggested_metadata,'{}'::jsonb) || ${JSON.stringify({…})}::jsonb`
//   ✅ suggested_metadata: sql`coalesce(suggested_metadata,'{}'::jsonb) - 'stale_key'`
//   ❌ suggested_metadata: sql`${JSON.stringify({…})}::jsonb`          // full replace
//   ❌ suggested_metadata: JSON.stringify({ ...metaReadEarlier, x })   // stale-snapshot replace
//
// The second ❌ is the sneaky one: reading the row into memory, spreading it, and
// writing it back looks safe but silently drops anything a CONCURRENT or DETACHED
// pass committed between the read and the write. Both forms shipped real
// data-loss bugs in core-scan: a photo re-run wiped `photo_distinct` (erasing the
// "2 different items — split?" offer, then paying a second vision call to
// rediscover it) and `keep_grouped` (throwing away the user's ANSWER and asking
// again). The fix is never "remember to copy the keys forward" — it's to merge.
//
// INSERTs are exempt (nothing to clobber). A genuinely-deliberate replace opts out
// with `// jsonb-replace-ok: <reason>` on or near the line.
//
// Runs against a committed BASELINE (scripts/jsonb-merge-baseline.json) so it only
// FAILS on NEW offenders; the baseline is the burn-down list. Local + CI, no deps.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "jsonb-merge-baseline.json");
const SCAN_DIRS = [join(ROOT, "api", "src"), join(ROOT, "modules")];
// How far back to look for the statement kind (.updateTable / .insertInto).
const LOOKBACK = 30;

interface Violation {
  file: string;
  line: number;
  column: string;
  snippet: string;
  key: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "tests") continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** The value expression for `key:` starting at `text[from]` (the char after ':'),
 *  read to its matching top-level `,` or `}`. Tracks (), {}, [], and backticks so
 *  a template literal's own braces/commas don't end it early. */
function readValueExpr(text: string, from: number): string {
  let depth = 0;
  let inTick = false;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      inTick = !inTick;
      continue;
    }
    if (inTick) {
      // `${` opens a real expression context inside the template.
      if (c === "$" && text[i + 1] === "{") {
        depth++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return text.slice(from, i);
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // A JSON column assigned from a JS-built value.
        const m = line.match(/^\s*([a-z_][a-z0-9_]*):\s*(sql`|JSON\.stringify\()/i);
        if (!m) continue;
        const column = m[1]!;

        // UPDATE or INSERT? Nearest statement kind above wins. An INSERT has
        // nothing to clobber, so a full value is correct there.
        let isUpdate = false;
        for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
          const l = lines[j]!;
          if (l.includes(".insertInto(")) break; // insert → exempt
          if (l.includes(".updateTable(")) {
            isUpdate = true;
            break;
          }
        }
        if (!isUpdate) continue;

        // The value expression, read across lines.
        const lineStart = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
        const colonAt = lineStart + line.indexOf(":", line.indexOf(column));
        const expr = readValueExpr(src, colonAt + 1);

        // Only JSON columns are in scope. `updated_at: sql`now()`` is a plain sql
        // fragment, not a bag someone else writes keys into.
        if (!/JSON\.stringify|::jsonb/.test(expr)) continue;

        // SAFE when the expression READS the column it writes — that's a DB-side
        // merge (`coalesce(col,'{}') || …`) or a key delete (`… - 'k'`), which
        // preserves whatever other writers put there.
        if (new RegExp(`\\b${column}\\b`).test(expr)) continue;

        // Explicit, reasoned opt-out.
        const ctx = lines.slice(Math.max(0, i - 2), i + 2).join("\n");
        if (/jsonb-replace-ok/.test(ctx)) continue;

        const snippet = line.trim().slice(0, 100);
        violations.push({ file: rel, line: i + 1, column, snippet, key: `${rel}::${column}::${snippet}` });
      }
    }
  }
  return violations;
}

const violations = scan();
// COUNTS, not a key set. Several offenders in one file share a snippet
// (`suggested_metadata: JSON.stringify({` five times over), so a bare set would
// collapse them — and then a NEW sixth one would slip in against a baselined key.
// The line number is deliberately NOT in the key: it would churn the baseline on
// every unrelated edit above it.
const counts = new Map<string, number>();
for (const v of violations) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);

if (process.argv.includes("--write-baseline")) {
  const obj = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(obj, null, 2) + "\n");
  console.log(`[lint:jsonb-merge] wrote baseline: ${violations.length} occurrence(s) over ${counts.size} site(s).`);
  process.exit(0);
}

let baseline: Record<string, number>;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
} catch {
  baseline = {};
}
const allowed = new Map(Object.entries(baseline));

const fresh = [...counts.entries()].filter(([k, n]) => n > (allowed.get(k) ?? 0));
const stale = [...allowed.keys()].filter((k) => !counts.has(k));
const baselineTotal = [...allowed.values()].reduce((a, b) => a + b, 0);

if (stale.length) {
  console.log(
    `[lint:jsonb-merge] ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} gone (converted?) — drop from jsonb-merge-baseline.json:`,
  );
  for (const k of stale) console.log(`  - ${k}`);
}

if (fresh.length === 0) {
  console.log(
    `[lint:jsonb-merge] ✓ no NEW full-replace writes to a JSON column (${baselineTotal} baselined / to convert).`,
  );
  process.exit(0);
}

console.error(
  `\n[lint:jsonb-merge] ✗ ${fresh.length} site(s) REPLACE a JSON column instead of merging it — every key another pass wrote is destroyed:`,
);
for (const [k, n] of fresh) {
  const v = violations.find((x) => x.key === k)!;
  const was = allowed.get(k) ?? 0;
  console.error(`  ${v.file}:${v.line}  ${v.snippet}${was ? `   (${n} now, ${was} baselined)` : ""}`);
}
console.error(
  `\nMerge DB-side instead:\n` +
    "  col: sql`coalesce(col, '{}'::jsonb) || ${JSON.stringify({ …only your keys… })}::jsonb`\n" +
    "…or, to drop a key:\n" +
    "  col: sql`coalesce(col, '{}'::jsonb) - 'key'`\n" +
    `\nIf a full replace is genuinely right, say why: // jsonb-replace-ok: <reason>\n` +
    `Convention: docs/design-decisions/scan-inbox-pipeline.md`,
);
process.exit(1);
