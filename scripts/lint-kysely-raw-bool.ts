#!/usr/bin/env tsx
// lint:kysely-raw-bool — a raw boolean SQL fragment is a predicate already;
// never compare it with eb(fragment, "=", true).
//
// Kysely splices the fragment verbatim, so
//   eb(sql<boolean>`x is not null`, "=", true)
// renders as `x is not null = true`, which Postgres rejects ("syntax error at
// or near =") — and `a <> 'b' = true` parses as `a <> ('b' = true)`, which is
// worse: it runs and answers the wrong question. Neither shape is caught by
// the type checker, because the fragment IS typed boolean and comparing a
// boolean to true is well-typed. The receipt-groups banner on Purchases 500'd
// on every workspace for ten days this way.
//
// Pass the fragment itself to where()/eb.and()/eb.or(): sql<boolean>`…` is an
// Expression<SqlBool> and needs no comparison.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["api/src", "modules", "packages"];
const SKIP_DIR = new Set(["node_modules", "dist", "ui", "__tests__"]);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* sources(full);
    else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) yield full;
  }
}

// eb(<raw boolean fragment>, "=" | "<>" | "!=" | "is", …) — the fragment may
// span lines, so match across newlines up to the closing backtick.
const BAD = /\beb\(\s*sql<\s*boolean\s*>`[^`]*`\s*,\s*["'](?:=|<>|!=|is|is not)["']/g;

const failures: string[] = [];
for (const root of SCAN_ROOTS) {
  let files: string[] = [];
  try {
    files = [...sources(join(ROOT, root))];
  } catch {
    continue;
  }
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(BAD)) {
      const line = src.slice(0, m.index).split("\n").length;
      failures.push(`${relative(ROOT, file)}:${line}: raw boolean fragment compared with eb(…, "${m[0].slice(-2, -1)}", …) — it renders as \`<fragment> = true\`, which Postgres cannot parse (or parses wrongly). Pass the fragment to where()/eb.and()/eb.or() directly.`);
    }
  }
}

if (failures.length) {
  console.error(`[lint:kysely-raw-bool] ✗ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:kysely-raw-bool] ✓ no raw boolean SQL fragment is compared with eb()");
