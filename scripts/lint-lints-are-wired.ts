#!/usr/bin/env tsx
// Every lint:* script must actually be RUN by something.
//
// WHY THIS IS A LINT: a check nothing invokes is not a guardrail, it is a file.
// It costs the same to write, reads the same in a PR ("shipped the fix AND the
// lint"), and catches exactly nothing. Two were found orphaned on 2026-07-30 -
// including `lint:scan-row-title`, added that same day and described in its own
// PR as the thing that "forces every response through withTitle()". It had never
// executed once.
//
// The wiring used to be per-lint CI steps, so this lint grepped ci.yml for each
// name. It is now DISCOVERY: scripts/run-lints.mjs reads package.json and runs
// every lint:* it finds, concurrently, in one step. So what has to be checked is
// different, and stronger:
//
//   1. run-lints.mjs's discovery covers every lint:* (minus its own MANUAL list),
//   2. something actually invokes run-lints.mjs — ci.yml and the pre-push hook,
//   3. MANUAL carries no entry for a lint that no longer exists.
//
// A new lint is now wired by existing. There is nothing to paste and nothing to
// forget, which is the property that stops the orphan class coming back.
//
//   npx tsx scripts/lint-lints-are-wired.ts   (npm run lint:lints-are-wired)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MANUAL, discoverLints } from "./run-lints.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { all, run } = discoverLints();
const ci = readFileSync(join(ROOT, ".forgejo", "workflows", "ci.yml"), "utf8");
const hook = readFileSync(join(ROOT, "scripts", "git-hooks", "pre-push"), "utf8");

const problems: string[] = [];

// 1. Discovery gap — a lint that is neither run by the runner nor MANUAL.
const orphans = all.filter((l) => !run.includes(l) && !(l in MANUAL));
if (orphans.length) {
  problems.push(
    `${orphans.length} lint script(s) are neither run by scripts/run-lints.mjs nor listed in its MANUAL:\n` +
      orphans.map((o) => `    - ${o}`).join("\n"),
  );
}

// 2. The runner itself must be invoked. Discovery is worthless if nothing calls it.
const runsTheRunner = (text: string) => /run-lints\.mjs|\blint:all\b/.test(text);
if (!runsTheRunner(ci)) {
  problems.push(
    "no CI job runs the lint suite — .forgejo/workflows/ci.yml must call `pnpm run lint:all`.\n" +
      "    Every lint is discovery-wired through that one step; without it, none of them run.",
  );
}
if (!runsTheRunner(hook)) {
  problems.push(
    "scripts/git-hooks/pre-push does not run `pnpm run lint:all`, so a push gets no local lint gate.",
  );
}

// 3. MANUAL rot: an entry for a lint that no longer exists hides the fact that
//    nobody re-checked the list. `lint:all` is the runner itself, not a script
//    it should find in its own discovery, so it is exempt from this check.
const stale = Object.keys(MANUAL).filter((m) => m !== "lint:all" && !all.includes(m));
if (stale.length) {
  problems.push(
    `MANUAL lists ${stale.length} lint(s) that no longer exist:\n` +
      stale.map((s) => `    - ${s}`).join("\n") +
      "\n    Remove them from MANUAL in scripts/run-lints.mjs.",
  );
}

if (problems.length === 0) {
  console.log(
    `[lint:lints-are-wired] ✓ all ${all.length} lint scripts are discovered by run-lints.mjs and run in ` +
      `CI + pre-push (${Object.keys(MANUAL).length - 1} deliberately manual).`,
  );
  process.exit(0);
}

console.error("\n[lint:lints-are-wired] ✗\n");
for (const p of problems) console.error(`  - ${p}\n`);
process.exit(1);
