#!/usr/bin/env tsx
// A test that runs a workflow's step or a CI script hands it outsideCiEnv(), never process.env, so the run it is in cannot steer the script.
//
// THE BUG THIS PREVENTS. 2026-10-18: GITHUB_REF_NAME=recheck/7269-... reached the tracker dedup step in ci-tracker-coalesces.test.ts, which took its re-check stand-down branch: #7269's re-check went red, green everywhere else (run 52230)
//
// THE RULE. A test file under scripts/ that reads a workflow (.forgejo/workflows) and runs bash may not spread
// process.env into a child: `...process.env` on any of its lines fails, unless the line says why with
// `// CI-ENV: <reason>`. outsideCiEnv() (scripts/lib/outside-ci-env.mjs) is process.env without the run's own
// GITHUB_/FORGEJO_/RUNNER_ variables and CI; the test then sets the event it means.
//
// THE BOUNDARY. Only tests that read a workflow and spawn bash: those run a workflow's step, which branches on
// the run's ref and event. A test that spawns git or node with process.env (the merge-tree fixtures) runs no step
// that reads GITHUB_*, and scripts/lib's own outsideCiEnv test reads process.env on purpose. Eight tests matched
// on 2026-10-18, one already red on re-checks.
//
// PROVED RED on ci-tracker-coalesces.test.ts as it was (8 of 8 failed with a re-check's GITHUB_REF_NAME set).
//
//   npx tsx scripts/lint-workflow-step-tests-run-outside-ci.ts   (pnpm lint workflow-step-tests-run-outside-ci)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.test\.(ts|mts|mjs)$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!src.includes(".forgejo/workflows") && !src.includes('".forgejo", "workflows"')) return out;
  if (!/(?:execFileSync|spawnSync|execFile|spawn)\(\s*["'`]bash["'`]/.test(src)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\.\.\.process\.env\b/.test(line) && !/\/\/ CI-ENV: \S/.test(line))
      out.push({ file, line: i + 1, what: "spreads process.env into a test that runs a workflow step: the run it is in (its ref, its event) steers the step" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workflow-step-tests-run-outside-ci - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("build the child env from outsideCiEnv() (scripts/lib/outside-ci-env.mjs) and set the event the test means");
  process.exit(1);
}
console.log(`lint:workflow-step-tests-run-outside-ci OK`);
