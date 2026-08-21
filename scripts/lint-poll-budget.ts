#!/usr/bin/env tsx
// A test's polling budget must fit inside its own timeout, with room for the
// requests the polling makes.
//
// WHY THIS IS A LINT: a counted retry loop bounds its SLEEPS and nothing else.
//
//   for (let t = 0; t < 120; t++) { await http(...); await sleep(500); }
//
// That reads as "wait up to 60s". It is not. It is "sleep up to 60s, plus 120
// requests of unbounded duration" — and against one API container shared by 8
// vitest forks, a request is not free. On 2026-08-21 digifab-runs.test.ts held
// exactly this loop followed by a second 30s one in the same test: 90s of
// nominal patience under a 60s testTimeout, so it could never spend its budget.
// Under CI contention it died as "Test timed out in 60000ms" — not as the
// assertion it was written to make — and because that file's tests chain state,
// two later tests failed with completely unrelated-looking numbers
// (completed_qty 2 instead of 1, scrapped 0 instead of 1). The visible symptom
// pointed nowhere near the cause.
//
// Nothing else catches this. It typechecks, it passes whenever the box is
// quiet, and it only fails under the load that makes the log hardest to read.
//
// THE RULE: nominal budget (iterations x sleep) must be at most 70% of the
// test's effective timeout, leaving 30% for the requests inside the loop. Fix
// by raising the timeout (`it("...", async () => {...}, BUDGET + SLACK)`) or,
// better, by polling against a wall-clock deadline so the requests count too —
// see the `until()` helper in api/tests/digifab-runs.test.ts.
//
//   npx tsx scripts/lint-poll-budget.ts   (pnpm run lint:poll-budget)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Fraction of the timeout a loop's sleeps may claim. The rest is for the
 *  requests the loop body makes, which the loop itself does not bound. */
const MAX_SLEEP_SHARE = 0.7;

/** vitest's testTimeout for a test dir, read from its config rather than
 *  assumed — a project that raises it should not trip this lint. */
function configuredTimeout(dir: string): number {
  for (const name of ["vitest.config.ts", "vitest.config.mts", "vite.config.ts"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const m = /testTimeout:\s*([0-9_]+)/.exec(readFileSync(p, "utf8"));
    if (m) return Number(m[1]!.replace(/_/g, ""));
  }
  return 5_000; // vitest's own default
}

/** `const FOO = 12_000;` declarations, so a derived timeout can be evaluated. */
function numericConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9_]+)\s*;/g)) {
    out.set(m[1]!, Number(m[2]!.replace(/_/g, "")));
  }
  return out;
}

/** Evaluate a timeout argument: a literal, a const, or a sum of those. */
function evalTimeout(expr: string, consts: Map<string, number>): number | null {
  let total = 0;
  for (const raw of expr.split("+")) {
    const t = raw.trim();
    if (/^[0-9_]+$/.test(t)) total += Number(t.replace(/_/g, ""));
    else if (consts.has(t)) total += consts.get(t)!;
    else return null; // something we can't evaluate — assume the author meant it
  }
  return total;
}

const LOOP = /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*([0-9_]+)\s*;\s*\1\+\+\s*\)/g;
const SLEEP = /\bsleep\(\s*([0-9_]+)\s*\)/;

interface Offence {
  file: string;
  line: number;
  budget: number;
  timeout: number;
}

/** Every test file under `dir`, at ANY depth.
 *
 *  This walks rather than listing one level, because listing one level is a
 *  lint that reports a clean pass over files it never opened. The first cut of
 *  this script did exactly that: it named web/src as covered, and web/src holds
 *  0 test files at its top level and 87 below it, so the reassuring green tick
 *  meant nothing for any of them. A check that silently inspects less than it
 *  claims is worse than no check, because it is believed. */
function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(p));
    else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

let loopsSeen = 0;

function check(file: string, defaultTimeout: number): Offence[] {
  const src = readFileSync(file, "utf8");
  const consts = numericConsts(src);
  const out: Offence[] = [];

  for (const m of src.matchAll(LOOP)) {
    const iterations = Number(m[2]!.replace(/_/g, ""));
    // The loop body: up to the matching close is hard without a parser, so take
    // a generous window. A sleep further away than this is not this loop's.
    const body = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
    const sleep = SLEEP.exec(body);
    if (!sleep) continue;
    loopsSeen++;
    const budget = iterations * Number(sleep[1]!.replace(/_/g, ""));

    // The enclosing it()'s explicit timeout, if it has one: the first `}, X);`
    // that closes a test after this loop.
    const after = src.slice(m.index!);
    const explicit = /\n\s*\}\s*,\s*([^)]+)\)\s*;/.exec(after);
    const timeout = explicit ? (evalTimeout(explicit[1]!, consts) ?? Infinity) : defaultTimeout;

    if (budget > timeout * MAX_SLEEP_SHARE) {
      out.push({
        file,
        line: src.slice(0, m.index!).split("\n").length,
        budget,
        timeout,
      });
    }
  }
  return out;
}

const dirs = [
  { dir: join(ROOT, "api", "tests"), config: join(ROOT, "api") },
  { dir: join(ROOT, "web", "src"), config: join(ROOT, "web") },
  { dir: join(ROOT, "modules"), config: ROOT },
  { dir: join(ROOT, "packages"), config: ROOT },
];

const offences: Offence[] = [];
let scanned = 0;
for (const { dir, config } of dirs) {
  const timeout = configuredTimeout(config);
  for (const f of testFiles(dir)) {
    scanned++;
    offences.push(...check(f, timeout));
  }
}
if (scanned === 0) {
  console.error("lint:poll-budget ✗ found NO test files — the walk is broken, which is worse than a red lint.");
  process.exit(1);
}

if (offences.length === 0) {
  console.log(
    `lint:poll-budget ✓ ${scanned} test files scanned, ${loopsSeen} polling loops, all fit inside their test's timeout`,
  );
  process.exit(0);
}

console.error("lint:poll-budget ✗ polling loops that cannot spend their own budget:\n");
for (const o of offences) {
  const share = Math.round((o.budget / o.timeout) * 100);
  console.error(
    `  ${relative(ROOT, o.file)}:${o.line}\n` +
      `    sleeps up to ${o.budget / 1000}s inside a ${o.timeout / 1000}s timeout (${share}%, max ${MAX_SLEEP_SHARE * 100}%)`,
  );
}
console.error(
  "\n  The loop bounds its SLEEPS, not the requests in its body, so real elapsed\n" +
    "  time runs past the timeout and the test dies as an opaque 'Test timed out'\n" +
    "  instead of the assertion it was written to make.\n\n" +
    "  Fix: give the test a timeout above its budget —\n" +
    '      it("...", async () => { ... }, BUDGET_MS + SLACK_MS);\n' +
    "  or poll against a wall-clock deadline so the requests count too (see the\n" +
    "  until() helper in api/tests/digifab-runs.test.ts).",
);
process.exit(1);
