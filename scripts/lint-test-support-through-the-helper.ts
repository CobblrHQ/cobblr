#!/usr/bin/env tsx
// An api test reaches a test-support door through testSupport() (api/tests/test-support.ts), never a bare fetch or http() to /test-support, so an api without the doors fails naming COBBLR_TEST_ORG_POOL instead of on an unrelated assertion.
//
// THE BUG THIS PREVENTS. a heal test failed on a throwaway api with 'expected [] to have a length of 1' because every unread setup call was a 404, and was misreported as date rot (2026-10-06)
//
// THE RULE. In api/tests, a string that names a test-support door
// ("/test-support/...", in quotes or a template) appears only in
// api/tests/test-support.ts, which reads every answer and names
// COBBLR_TEST_ORG_POOL when the doors are not there. A comment may name a door.
//
// THE BOUNDARY. helpers.ts is exempt: its pool checkout is the plumbing that
// decides whether a test gets a pooled workspace at all, reads every status
// itself (a 409 means "pool empty, sign up instead"), and must not throw when
// the pool is off, because a fresh signup is then the right answer.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-test-support-through-the-helper.ts   (pnpm lint test-support-through-the-helper)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];
const EXEMPT = new Set(["api/tests/test-support.ts", "api/tests/helpers.ts"]);

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
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (EXEMPT.has(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\/\/ .*$/, "");
    if (/["'`][^"'`]*\/test-support\//.test(code)) {
      out.push({ file, line: i + 1, what: "reaches a test-support door without testSupport() (api/tests/test-support.ts)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-support-through-the-helper - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:test-support-through-the-helper OK`);
