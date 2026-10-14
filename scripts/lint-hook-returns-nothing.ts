#!/usr/bin/env tsx
// A test hook's arrow body must not RETURN a chainable mock call: vitest treats a function returned from a hook as that hook's teardown and calls your mock after every test
//
// THE BUG THIS PREVENTS. beforeEach(() => feed.fn.mockReset()) returned the mock, vitest registered it as teardown and called it with no arguments after every test in the file; the file's mock threw, and a test whose assertions had all passed failed pointing at a line it never ran in that order (2026-09-22, #3417)
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-hook-returns-nothing.ts   (pnpm run lint:hook-returns-nothing)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests", "modules", "packages", "web/src", "scripts"];

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
    // TEST files are the whole subject here, where most lints skip them.
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** Every chainable helper vitest's mocks return: each one answers with the
 *  mock itself, so an arrow that ends in a call to one RETURNS a function. */
const CHAINABLE = [
  "mockReset",
  "mockClear",
  "mockRestore",
  "mockImplementation",
  "mockImplementationOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockName",
];
const HOOK = /\b(beforeEach|afterEach|beforeAll|afterAll)\s*\(\s*\(\s*\)\s*=>\s*(.+)$/;
const CALL = new RegExp(`\\.(${CHAINABLE.join("|")})\\s*\\(`);

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = HOOK.exec(line);
    if (!m) continue;
    const body = m[2] ?? "";
    // A BLOCK body returns undefined, which is the fix and the common case.
    if (body.trimStart().startsWith("{")) continue;
    if (!CALL.test(body)) continue;
    if (/\/\/ HOOK-RETURNS-TEARDOWN: /.test(line)) continue;
    out.push({
      file,
      line: i + 1,
      what: `${m[1]} returns a mock (its arrow body ends in a chainable mockX call), so vitest registers the MOCK as this hook's teardown and calls it after every test. Use a block body: ${m[1]}(() => { ...; });`,
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:hook-returns-nothing - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:hook-returns-nothing OK`);
