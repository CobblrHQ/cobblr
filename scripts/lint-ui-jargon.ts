#!/usr/bin/env tsx
// UI-jargon lint. A user-facing COUNT must read in the item's OWN noun ("5
// machines"), never DB-speak ("5 rows" / "5 records" / "5 entities"). That leaked
// into the dashboard + Views count labels (reported 2026-07-11: "you should use the
// nouns that came with the items, not 5 rows").
//
// Flags a JSX / template count label — `{expr} rows|records|entities` — in a
// .tsx file. The `rows={N}` textarea/prop ATTRIBUTE is not a label and is
// excluded (the offense word must not be followed by `=`). Derive the noun from
// the kind instead (e.g. `entity_kind.split(":")[1]` -> "machine").
//
// Runs against a committed BASELINE (scripts/ui-jargon-baseline.json) of
// genuinely-technical uses where "rows" is honest (a DB-restore row count, a
// CSV-file row count). Clear one and drop it from the baseline, or add a new
// legitimately-technical one with `--write-baseline`. Any NEW jargon fails.
//
//   cd <repo> && npx tsx scripts/lint-ui-jargon.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["web/src", "modules"];
const BASELINE = join("scripts", "ui-jargon-baseline.json");
// A `}` closing a JSX expr / template `${}`, then the jargon noun, NOT followed
// by `=` (a `rows={8}` attribute) or `.`/`[` (a `.rows` / `["rows"]` access).
const OFFENSE = /\}\s*(rows|records|entities)\b(?!\s*[=.[])/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  snippet: string;
  key: string;
}

const found: Finding[] = [];
for (const root of ROOTS) {
  for (const file of tsxFiles(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (!OFFENSE.test(l)) return;
        const snippet = l.trim();
        found.push({ file, line: i + 1, snippet, key: `${file}::${snippet}` });
      });
  }
}

if (process.argv.includes("--write-baseline")) {
  const keys = [...new Set(found.map((f) => f.key))].sort();
  writeFileSync(BASELINE, JSON.stringify(keys, null, 2) + "\n");
  console.log(`[lint:ui-jargon] wrote baseline with ${keys.length} entr${keys.length === 1 ? "y" : "ies"}.`);
  process.exit(0);
}

let baseline: Set<string>;
try {
  baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
} catch {
  baseline = new Set();
}
const violations = found.filter((f) => !baseline.has(f.key));

if (violations.length > 0) {
  console.error(`✗ ui-jargon lint: ${violations.length} NEW user-facing count(s) using DB-speak instead of the item's noun:\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet.slice(0, 110)}`);
  console.error(`\nA count shown to a user must read in the item's OWN noun ("5 machines"), not "5 rows".
Derive it from the kind: const noun = entity_kind.split(":")[1]. If this is a genuinely
technical count (a DB-restore or CSV-file row count), add it with:
  npx tsx scripts/lint-ui-jargon.ts --write-baseline`);
  process.exit(1);
}
console.log(`✓ ui-jargon lint: no new DB-speak in user-facing counts (${baseline.size} baselined).`);
