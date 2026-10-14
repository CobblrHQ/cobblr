#!/usr/bin/env tsx
// A test's vi.mock names a module that exists, because a mock of a path nothing imports mocks nothing and the test passes against the real module
//
// THE BUG THIS PREVENTS. 2026-10-09 (#5443): moving a test from api/tests to api/src left vi.mock("../src/db/meta.js") pointing nowhere; the test passed, mocking nothing
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Name the near-miss that
// made the scope what it is: the thing that looked like a violation, is not
// one, and is why the rule stops where it does. A scope drawn by a real
// near-miss keeps its precision; one drawn by imagination does not. If
// nothing has tested the boundary yet, say that instead of inventing one.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-test-mocks-resolve.ts   (pnpm lint test-mocks-resolve)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api", "modules", "packages", "web", "scripts", "ops-console"];

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
    else if (/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(/\b(?:vi\.(?:mock|doMock|unmock|importActual|importMock)|importActual)\(\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1]!;
      const p = normalize(join(dirname(file), spec));
      const cands = [p, p.replace(/\.js$/, ".ts"), p.replace(/\.js$/, ".tsx"), p.replace(/\.mjs$/, ".mts"), `${p}.ts`, `${p}.tsx`, join(p, "index.ts")];
      if (!cands.some((c) => existsSync(c))) out.push({ file, line: i + 1, what: `mocks "${spec}", which resolves to no file from here: the mock mocks nothing and the test runs against the real module` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-mocks-resolve - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("point the specifier at the module's path from this file");
  process.exit(1);
}
console.log(`lint:test-mocks-resolve OK`);
