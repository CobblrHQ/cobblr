#!/usr/bin/env tsx
// An empty state shows only once its read has answered (q.isSuccess), never on !q.isLoading, so a read the server refused or failed is said, not shown as an empty list.
//
// THE BUG THIS PREVENTS. Locations said No locations yet over a workspace with a garage when its read was refused (401) or failed (500), 2026-11-18; 46 pages had the same condition
//
// THE RULE. A JSX condition that shows something because a list is empty
// (`<x>.length === 0`) and rules out only loading (`!q.isLoading`,
// `!q.isPending` or `!q.isFetching`) fails: a read that failed is not loading
// either, so it passes that test and the empty state shows. It passes when the
// same condition also names `q.isSuccess`, `q.isError`, `q.error` or
// `q.status`. A condition that is right to show its empty state after a failed
// read says so on the line or the one above: `// empty-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only a read's loading flag:
// a name this file assigns from useQuery or useInfiniteQuery. Design files'
// empty state also waits on `!upload.isPending`, a mutation still sending a
// file, which has no read to fail; that drew the line. An empty state over a
// local array has no read either. The Lists detail page already wrote
// `!detail.isLoading && !detail.isError`, which passes as it should.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-an-empty-state-waits-for-a-read-that-answered.ts   (pnpm lint an-empty-state-waits-for-a-read-that-answered)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const EMPTY_STATE = /\{([^{}\n]*\.length\s*===\s*0[^{}\n]*)&&\s*[(<]/g;
const ONLY_LOADING = /!\s*\(?\s*(\w+)\.(isLoading|isPending|isFetching)\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(EMPTY_STATE)) {
      const cond = m[1] ?? "";
      const loading = ONLY_LOADING.exec(cond);
      if (!loading) continue;
      const q = loading[1]!;
      // Only a read: a mutation's isPending (an upload still sending) has no read to fail.
      if (!new RegExp(`\\b${q}\\s*=\\s*use(Infinite)?Query\\b`).test(src)) continue;
      if (new RegExp(`\\b${q}\\.(isSuccess|isError|error|status)\\b`).test(cond)) continue;
      if (/\/\/\s*empty-ok: \S/.test(line) || /\/\/\s*empty-ok: \S/.test(lines[i - 1] ?? "")) continue;
      out.push({ file, line: i + 1, what: `an empty state on !${q}.${loading[2]} also shows when ${q}'s read failed` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:an-empty-state-waits-for-a-read-that-answered - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Gate the empty state on q.isSuccess and show <QueryError> on q.isError");
  process.exit(1);
}
console.log(`lint:an-empty-state-waits-for-a-read-that-answered OK`);
