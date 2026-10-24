#!/usr/bin/env tsx
// A script that reads a commit's statuses reads every page of them, through scripts/lib/head-statuses.mjs, or says
// why one page is the point
//
// THE BUG THIS PREVENTS. The forge keeps every status a commit was given, 50 to a page, newest first. The merge
// queue's admission tick read page 1, and each move in its line posted one more `merge-queue / admission` row: by
// the evening of 2026-10-22, 23 pull requests had their own CI rows on page 2, read as not due, left the line with
// their last "3 of 34" standing, and waited from 19:14Z while newer ones went ahead (#6226). Main's own commits
// already carry 26 to 44 rows, so every page-1 reader of a head or of main sat at the same edge.
//
// THE RULE. A line in scripts/ or a workflow that asks the forge for `commits/<sha>/statuses` (the list, not a POST
// to `/statuses/<sha>`) reads it through head-statuses.mjs (`headStatuses(` in JavaScript, or its command line from
// a shell or a workflow), or pages it itself (a page number that moves: `page=${n}`, `page=$n`), or carries
// `ONE-PAGE: <why>` on the line or the two above it.
//
// THE BOUNDARY. Tests are skipped: a test's fake forge serves what it is asked for. The combined
// `commits/<sha>/status` (one row per context) is another endpoint and is not judged here.
//
//   npx tsx scripts/lint-status-lists-are-paged.ts   (pnpm lint status-lists-are-paged)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const ROOTS = ["scripts", ".forgejo/workflows", ".agents/coordinator"];
const HELPER = "scripts/lib/head-statuses.mjs";

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
    if (name === "node_modules" || name === "dist" || (name.startsWith(".") && name !== ".forgejo")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js|cjs|sh|py|yml)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) yield p;
  }
}

/** PURE. Every one-page read of a commit's statuses in one file. */
export function check(file: string, src: string): Violation[] {
  if (file === HELPER || file === "scripts/lint-status-lists-are-paged.ts") return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/commits\/[^\s"'`]*\/statuses(\?|["'`]|\s|$)/.test(line)) continue;
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    if (/page=\$\{?\w|page=\{\w+\}|headStatuses\(|head-statuses\.mjs/.test(line)) continue;
    const near = [lines[i - 2] ?? "", lines[i - 1] ?? "", line].join("\n");
    if (/ONE-PAGE: \S/.test(near)) continue;
    out.push({ file, line: i + 1, what: "one page of a commit's statuses read as all of them (the forge answers 50 a page, newest first)" });
  }
  return out;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:status-lists-are-paged - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error(`read them with headStatuses(get, sha) from ${HELPER}, or \`node ${HELPER} <sha>\` from a shell; a deliberate window says // ONE-PAGE: <why> (or # ONE-PAGE: in shell) on the line above`);
    process.exit(1);
  }
  console.log("lint:status-lists-are-paged OK");
}
