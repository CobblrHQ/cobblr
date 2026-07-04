#!/usr/bin/env tsx
// Pagination lint — enforces the "infinite scroll is the default" convention
// (docs/design-decisions/list-pagination.md). It flags a plain `useQuery` list
// fetch that passes a hard `limit: N` (N >= THRESHOLD) — the pattern that caps
// data + shows a lying `items.length` count (the "100 actions" bug). Growable
// lists should use `useInfiniteQuery` + `{items, next_cursor, total}` instead.
//
//   npx tsx scripts/lint-pagination.ts        (npm run lint:pagination)
//
// Runs against a committed BASELINE (scripts/pagination-baseline.json) of the
// caps that predate the convention, so it only FAILS on NEW offenders — the
// baseline is the live to-convert backlog. Convert a list (or, for a genuinely
// bounded one, add `// paginate-ok: <reason>`) and drop it from the baseline.
// Local + CI, free, no deps beyond fs.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = join(ROOT, "web", "src");
const BASELINE = join(ROOT, "scripts", "pagination-baseline.json");
const THRESHOLD = 25; // a limit this size is "a list", not a bounded handful
const LOOKBACK = 12; // lines above the limit: to find the enclosing query hook

interface Violation {
  file: string;
  line: number;
  snippet: string;
  key: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (/\.(tsx|ts)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(WEB_SRC)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/\blimit:\s*(\d+)/);
      if (!m || Number(m[1]) < THRESHOLD) continue;
      // What query hook encloses this? Look back for the nearest of the two.
      let hook: "infinite" | "query" | null = null;
      for (let j = i; j >= Math.max(0, i - LOOKBACK); j--) {
        if (lines[j]!.includes("useInfiniteQuery")) { hook = "infinite"; break; }
        if (lines[j]!.includes("useQuery(")) { hook = "query"; break; }
      }
      if (hook !== "query") continue; // infinite → good; neither → not a list query
      const ctx = [lines[i - 1] ?? "", lines[i]!, lines[i + 1] ?? ""].join("\n");
      if (/paginate-ok/.test(ctx)) continue; // explicit, reasoned bounded list
      const snippet = lines[i]!.trim();
      violations.push({ file: rel, line: i + 1, snippet, key: `${rel}::${snippet}` });
    }
  }
  return violations;
}

function loadBaseline(): string[] {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
  } catch {
    return [];
  }
}

const violations = scan();
const keys = new Set(violations.map((v) => v.key));

if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE, JSON.stringify([...keys].sort(), null, 2) + "\n");
  console.log(`[lint:pagination] wrote baseline with ${keys.size} entr${keys.size === 1 ? "y" : "ies"}.`);
  process.exit(0);
}

const baseline = new Set(loadBaseline());
const fresh = violations.filter((v) => !baseline.has(v.key));
const stale = [...baseline].filter((k) => !keys.has(k));

if (stale.length) {
  console.log(`[lint:pagination] ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} gone (converted?) — drop from pagination-baseline.json:`);
  for (const k of stale) console.log(`  - ${k}`);
}

if (fresh.length === 0) {
  console.log(`[lint:pagination] ✓ no NEW capped list fetches (${baseline.size} baselined / to convert). See docs/design-decisions/list-pagination.md`);
  process.exit(0);
}

console.error(`\n[lint:pagination] ✗ ${fresh.length} NEW capped list fetch(es) — use useInfiniteQuery + {items,next_cursor,total}, or add "// paginate-ok: <reason>" if genuinely bounded:`);
for (const v of fresh) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
console.error(`\nConvention: docs/design-decisions/list-pagination.md (exemplar: DigifabPage / modules/digifab/src/api/jobs.ts)`);
process.exit(1);
