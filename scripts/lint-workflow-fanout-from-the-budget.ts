#!/usr/bin/env tsx
// A workflow step that fans out (xargs -P) takes its width from the job's memory budget (scripts/lib/job-budget.mjs), never a fixed number, because the same job lands on boxes and caps of different sizes
//
// THE BUG THIS PREVENTS. 2026-10-09: the nightly tour's build ran xargs -P 12 under the 6.5 GB cap of the e2e runner; the kernel killed two builds, and every walk after it failed 'no verdict' as if a hundred screens had broken (run 40441)
//
// THE RULE. In a workflow under .forgejo/workflows, `xargs -P <number>` above 1 is a violation; a width
// from a variable (`xargs -P "$P"`, P read from scripts/lib/job-budget.mjs) passes. A fan-out that is
// not memory-bound says why on the line: `# fixed-width: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. ci.yml's comment "`xargs -P 12` + vitest maxForks"
// explains a past budget and runs nothing: a line that is a comment (after `#`) is not judged.
// `-P 1` (one at a time) is no fan-out.
//
// PROVE IT RED: it was run against nightly-tour.yml and e2e-suite.yml before their fix.
//
//   npx tsx scripts/lint-workflow-fanout-from-the-budget.ts   (pnpm lint workflow-fanout-from-the-budget)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo/workflows"];

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
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/(^|\s)#.*$/, "");
    const m = /\bxargs\b[^|;&]*\s-P\s*["']?([0-9]+)/.exec(code);
    if (m && Number(m[1]) > 1 && !/# fixed-width: \S/.test(line)) {
      out.push({ file, line: i + 1, what: `xargs -P ${m[1]}: a fixed fan-out width; take it from scripts/lib/job-budget.mjs` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workflow-fanout-from-the-budget - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("P=\"$(node scripts/lib/job-budget.mjs tsc)\"; xargs -P \"$P\" ...");
  process.exit(1);
}
console.log(`lint:workflow-fanout-from-the-budget OK`);
