#!/usr/bin/env tsx
// A script that judges a page waits for the app's settled signal (scripts/lib/wait-settled.mjs), never for networkidle, which a page that polls never reaches, or says why with // networkidle: <why>
//
// THE BUG THIS PREVENTS. The fundamentals nightly waited for networkidle on
// every page. Its pages poll, so the network never goes quiet and every page
// waited out the 20 s cap: on a slow staging night (2026-10-03) only 7 of 10
// areas fit in the night's hour, and three went unwalked.
//
// THE RULE. A .mjs under scripts/ (the tools that drive the app and judge
// it: the nightly, its sweep, walk.mjs, the UI walker) never waits for
// "networkidle", as a load state or a goto's waitUntil. It calls waitSettled()
// from scripts/lib/wait-settled.mjs, which reads the app's own
// <html data-settled> (web/src/components/SettledMarker.tsx). An exception
// says why on the line before or the same line: `// networkidle: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. scripts/perf-measure.mjs
// times a full first load, the one thing a settle signal would cut short:
// it is why the opt-out exists. Comments mentioning the word do not count.
// e2e/ is not in scope yet: its 288 scripts are the yardsticks and demos,
// many written against networkidle; they move as they are touched.
//
//   npx tsx scripts/lint-no-networkidle-wait.ts   (pnpm lint no-networkidle-wait)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./lib/source-scan.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts"];

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
    else if (/\.mjs$/.test(name) && !/\.test\.mjs$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const raw = src.split("\n");
  const code = stripComments(src).split("\n");
  for (let i = 0; i < code.length; i++) {
    if (!/["'`]networkidle["'`]/.test(code[i] ?? "")) continue;
    if (/\/\/ networkidle: \S/.test(raw[i] ?? "") || /\/\/ networkidle: \S/.test(raw[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "waits for networkidle, which a page that polls never reaches: await waitSettled(page) from scripts/lib/wait-settled.mjs" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-networkidle-wait - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:no-networkidle-wait OK`);
