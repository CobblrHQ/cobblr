#!/usr/bin/env tsx
// A walk or harness under e2e/ or scripts/ never sets suggested_category on a scan import row: that is the interop field, an AI prompt hint the no-AI router never reads, and a route asserted on such a row proves nothing; the category goes in x_cobblr.metadata.category (scripts/lib/scan-fixture.mjs writes it there).
//
// THE BUG THIS PREVENTS. the first #3155 rig walk (2026-09-20) imported every seed's category as suggested_category, every seed read Plants, and a correct change looked broken
//
// THE RULE. Every .mjs, .ts and .tsx under e2e/ and scripts/ (walks,
// harnesses, fixture builders; tests included, since a fixture test that
// builds the wrong envelope is the same trap) is read line by line; a line
// that writes `suggested_category` as an object key (`suggested_category:`)
// fails. Reading the field (`.suggested_category`, a string in a message, a
// comment) passes. A file whose JOB is the interop contract (an importer's
// own test of the field) opts out with `// SCAN-FIXTURE-INTEROP: <why>` on
// the line. The helper and this lint's own text mention the word and do not
// write the key.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-scan-fixture-category.ts   (pnpm run lint:scan-fixture-category)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e", "scripts"];

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
    else if (/\.(mjs|ts|tsx)$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (file.endsWith("lint-scan-fixture-category.ts")) continue;
    if (/(^|[^.\w])["']?suggested_category["']?\s*:/.test(line) && !/\/\/ SCAN-FIXTURE-INTEROP: /.test(line)) {
      out.push({ file, line: i + 1, what: "writes suggested_category on a scan import row (an AI prompt hint the router never reads); use category via scanImportEnvelope, or x_cobblr.metadata.category" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-fixture-category - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("build the envelope with scanImportEnvelope from scripts/lib/scan-fixture.mjs, or pass a hand-built one through assertRouterCategories");
  process.exit(1);
}
console.log(`lint:scan-fixture-category OK`);
