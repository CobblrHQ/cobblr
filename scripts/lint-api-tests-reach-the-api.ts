#!/usr/bin/env tsx
// A new api integration test reaches the api or a database, because a test of plain logic belongs in the unit suite where it costs no workspace
//
// THE BUG THIS PREVENTS. 2026-10-09 (#5443): 320 of 1,082 api suite files reached neither the api nor a database; the suite had quadrupled in two months, much of it pure logic paying for a workspace
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
//   npx tsx scripts/lint-api-tests-reach-the-api.ts   (pnpm lint api-tests-reach-the-api)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reachesTheApi } from "./test-cost.mjs";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];

/** The files that were already here when the rule began (2026-10-09), a SHRINK-ONLY list: each one
 *  is a move waiting to happen (#5443 step 2), never a new file's way in. Below, an entry whose file
 *  is gone or now reaches the api is refused as stale, so the list only ever gets shorter. */
const BASELINE_FILE = "scripts/lint-api-tests-reach-the-api.baseline";
const BASELINE = new Set(readFileSync(BASELINE_FILE, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));

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
    void line;
  }
  const rel = file.replace(/\\/g, "/");
  if (reachesTheApi(src) || /\/\/ api-suite: \S/.test(src) || BASELINE.has(rel)) return out;
  out.push({ file, line: 1, what: "its own source shows no api or database use: put it beside the code it tests (pnpm run where-test says where); if it reaches one through an import, say so on a line: // api-suite: <why it needs the api suite>" });
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));
// The baseline only shrinks. An entry whose file moved out, or that now reaches the api, is stale:
// said, never failed (a move PR and this baseline landing in either order must not block each other),
// and `--prune` takes them off. A NEW file is what fails, above.
const stale = [...BASELINE].filter((f) => !existsSync(f) || reachesTheApi(readFileSync(f, "utf8")));
if (stale.length && process.argv.includes("--prune")) {
  const keep = readFileSync(BASELINE_FILE, "utf8").split("\n").filter((l) => !stale.includes(l.trim()));
  writeFileSync(BASELINE_FILE, keep.join("\n"));
  console.log(`lint:api-tests-reach-the-api: pruned ${stale.length} stale baseline entr${stale.length === 1 ? "y" : "ies"}`);
} else if (stale.length) {
  console.log(`lint:api-tests-reach-the-api: ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale (moved out, or now reaching the api): npx tsx scripts/lint-api-tests-reach-the-api.ts --prune`);
}


if (violations.length) {
  console.error(`lint:api-tests-reach-the-api - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("move it beside the code it tests (pnpm run where-test says where), or say why on its first line: // api-suite: <why it needs the api suite>");
  process.exit(1);
}
console.log(`lint:api-tests-reach-the-api OK`);
