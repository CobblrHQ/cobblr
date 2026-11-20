#!/usr/bin/env tsx
// A script takes where a check stands from latestPerContext, latestOf or newestRow in scripts/lib/head-statuses.mjs, never by sorting or comparing status rows' ids or times itself, so a same-second pair is never read as the wrong row.
//
// THE BUG THIS PREVENTS. Three finished CI test jobs were read as six hours running and reported stuck: a hand-written reader took the first of a same-second pair (2026-11-20)
//
// THE RULE. Where a status row is picked (a `.context` within a few lines),
// code that orders or compares rows itself fails: a sort on `.id`, a
// `Number(x.id) > Number(y.id)` or `(x.id ?? 0) > ...` comparison, or a sort
// on created_at/updated_at. The newest row is the highest id, and only
// scripts/lib/head-statuses.mjs says so: latestPerContext(rows),
// latestOf(rows, context), newestRow(rows, pick). A genuine exception (a
// comparison that is not a pick, "a row posted after this one") carries
// `// STATUS-ROW-OK: <reason>` on its line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Workflow RUNS sorted by id
// (release-full-run's newestFirst), coverage entries and label jobs sorted by
// their own ids are not status rows: no `.context` is read near them, so they
// pass. ci-admission's "a run row posted after the admission row" compares ids
// to ask what came later, not to pick one, and carries the reason. Python
// (commit-ci-state.py) keeps its own one picker and is not judged here.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-status-row-is-picked-by-the-helper.ts   (pnpm lint a-status-row-is-picked-by-the-helper)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts", ".forgejo"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(tsx?|mjs|js)$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (/scripts\/lib\/head-statuses\.mjs$/.test(file) || !/\.(m?js|ts)$/.test(file)) return [];
  const out: Violation[] = [];
  const raw = src.split("\n");
  const lines = stripComments(src).split("\n");
  const picks = [
    /\.sort\(\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(?\s*(Number\()?\w+\.id\b/,
    /Number\(\s*\w+\.id\s*\)\s*[<>]=?\s*Number\(/,
    /\(\s*\w+\.id\s*\?\?\s*0\s*\)\s*[<>]=?\s*\(/,
    /\.sort\([^)]*\b(created_at|updated_at)\b/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!picks.some((re) => re.test(line))) continue;
    const near = lines.slice(Math.max(0, i - 4), i + 3).join("\n");
    if (!/\.context\b|context ===|"context"|\bcontext\)/.test(near)) continue;
    if (/STATUS-ROW-OK: \S/.test(`${raw[i - 1] ?? ""}\n${raw[i] ?? ""}`)) continue;
    out.push({ file, line: i + 1, what: "picks a status row itself; take it from latestPerContext, latestOf or newestRow (lib/head-statuses.mjs)" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-status-row-is-picked-by-the-helper - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use latestPerContext(rows), latestOf(rows, context) or newestRow(rows, pick) from scripts/lib/head-statuses.mjs");
  process.exit(1);
}
console.log(`lint:a-status-row-is-picked-by-the-helper OK`);
