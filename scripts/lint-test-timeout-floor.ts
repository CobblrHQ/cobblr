#!/usr/bin/env tsx
// A per-test timeout may raise the global ceiling. It may never lower it.
//
// THE BUG THIS EXISTS FOR (2026-08-17): a PR touching four files — a shell
// script, a hook, a doc and a changelog entry — went red on
// `core-ai-create-and-models.test.ts > OpenRouter preset`, a test it cannot
// reach. The failure was not an assertion. It was `Test timed out in 20000ms`,
// while a neighbouring fork provisioned a whole tenant (a fresh postgres
// database and every module migration) in the same window.
//
// The suite's global testTimeout is 60s, and the comment above it in
// api/vitest.config.ts names the exact hazard: "Tail operations like DELETE
// /orgs (DROP DATABASE + cascade) can push past 20s under load. Generous so CI
// flake isn't a thing." Nine tests then hardcoded `{ timeout: 20000 }` — three
// times tighter than the number chosen to absorb that load, on tests that each
// call signupFreshOrg() and therefore do the very provisioning the global was
// widened for.
//
// It had already been paid for once. graduation-photos.test.ts carries the
// note "A tighter ceiling here (was 60s) reintroduced flake" — the lesson
// learned, written as a comment at one call site, while the same mistake sat
// in nine others. A comment reminds whoever reads that file. This stops it
// everywhere, including in code an agent writes at 3am.
//
// Raising the ceiling is fine and stays unflagged: digifab's pool tests ask for
// 70s and 120s because they genuinely wait on real work. The asymmetry is the
// whole rule — a bigger number can only cost patience, a smaller one invents a
// failure that is not there.
//
//   npx tsx scripts/lint-test-timeout-floor.ts   (npm run lint:test-timeout-floor)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "api", "vitest.config.ts");

/** A test that genuinely asserts a latency bound says so and is left alone. */
const OPT_OUT = /TIMEOUT-FLOOR:/;

function globalTimeout(): number {
  const src = readFileSync(CONFIG, "utf8");
  const m = /^\s*testTimeout:\s*([0-9_]+)/m.exec(src);
  if (!m) {
    console.error(
      `[lint:test-timeout-floor] ✗ no testTimeout in ${relative(ROOT, CONFIG)} — ` +
        `the floor is read from there, so this lint cannot judge anything. Did the config move?`,
    );
    process.exit(1);
  }
  return Number(m[1]!.replace(/_/g, ""));
}

function testFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.[cm]?tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FLOOR = globalTimeout();
const files = [
  ...testFiles(join(ROOT, "api", "tests")),
  ...testFiles(join(ROOT, "modules")),
];

const errors: string[] = [];
let overrides = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = /\btimeout:\s*([0-9_]+)/.exec(line);
    if (!m) return;
    overrides++;
    const value = Number(m[1]!.replace(/_/g, ""));
    if (value >= FLOOR) return;
    if (OPT_OUT.test(line) || OPT_OUT.test(lines[i - 1] ?? "")) return;
    errors.push(
      `${relative(ROOT, file)}:${i + 1} sets timeout: ${value}, below the ${FLOOR} global. ` +
        `A tighter ceiling cannot make a test pass — it can only invent a failure when the ` +
        `runner is busy provisioning another tenant.`,
    );
  });
}

if (files.length === 0) {
  console.error("[lint:test-timeout-floor] ✗ found no test files at all — did the test dirs move?");
  process.exit(1);
}

if (errors.length === 0) {
  console.log(
    `[lint:test-timeout-floor] ✓ ${overrides} timeout override(s) across ${files.length} test files, none below the ${FLOOR} global`,
  );
  process.exit(0);
}
console.error(`\n[lint:test-timeout-floor] ✗ ${errors.length} timeout(s) below the global floor:\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nDelete the override and inherit the global — it was set generous on purpose.\n` +
    `Raising it above ${FLOOR} is always allowed. If a test genuinely asserts a latency\n` +
    `bound, say so on the line or the one above it: // TIMEOUT-FLOOR: <why>\n`,
);
process.exit(1);
