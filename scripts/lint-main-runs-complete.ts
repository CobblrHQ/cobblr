#!/usr/bin/env tsx
// A workflow that measures main, or runs on a schedule, must run to completion.
//
// THE BUG THIS EXISTS FOR (2026-09-09). bench-on-merge.yml shipped with the
// one-line form `concurrency: bench`. On Forgejo that shorthand CANCELS the run
// in progress when the next one starts. Twenty-nine minutes into the first
// merge-time corpus bench, another agent merged, the second run started, and
// the first was cancelled: no verdict posted, ~150 model calls thrown away,
// and on a busy afternoon the bench could never have finished at all.
//
// ci.yml already knew: "let every push to MAIN run to completion, so each
// commit on main gets a trustworthy per-commit green/red signal instead of a
// 'cancelled' that makes 'is main green?' unanswerable." It sets
// cancel-in-progress conditionally, and bake-pool.yml and ci-tracker.yml set
// it to false. The precedent was one file over and the shorthand does not
// look like a decision, which is why this is a lint and not a note.
//
// THE RULE. A workflow that runs on push to main or on a schedule and declares
// `concurrency` must set `cancel-in-progress` to `false`, or to an expression
// that is false on main (ci.yml's form). The bare string shorthand is refused
// on those workflows, because its default is the wrong one for them.
//
//   cd <repo> && npx tsx scripts/lint-main-runs-complete.ts

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".forgejo/workflows");

const findings: string[] = [];

for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const src = readFileSync(join(DIR, f), "utf8");
  // Does it measure main, or run on its own clock?
  const onBlock = src.match(/^on:\s*\n((?:[ \t]+.*\n?)+)/m)?.[1] ?? "";
  const pushesMain =
    /^\s+push:\s*\n(?:\s+branches:\s*\[[^\]]*\bmain\b[^\]]*\]|\s+branches:\s*\n\s+-\s*main\b)/m.test(onBlock) ||
    (/^\s+push:\s*(\n|$)/m.test(onBlock) && !/^\s+branches:/m.test(onBlock));
  const scheduled = /^\s+schedule:/m.test(onBlock);
  if (!pushesMain && !scheduled) continue;

  const shorthand = src.match(/^concurrency:[ \t]*([^\s{#][^\n]*)$/m);
  const block = src.match(/^concurrency:\s*\n((?:[ \t]+.*\n?)+)/m)?.[1];
  const why = pushesMain ? "runs on push to main" : "runs on a schedule";
  if (shorthand) {
    findings.push(`  ${f}: \`concurrency: ${(shorthand[1] ?? "").trim()}\` ${why}; the shorthand cancels the run in progress`);
    continue;
  }
  if (!block) continue; // no concurrency: nothing to cancel
  const cip = block.match(/cancel-in-progress:\s*(.+)$/m)?.[1]?.trim();
  if (!cip) {
    findings.push(`  ${f}: concurrency without cancel-in-progress ${why}; the default cancels the run in progress`);
    continue;
  }
  const safe = cip === "false" || /github\.ref\s*!=\s*'refs\/heads\/main'/.test(cip);
  if (!safe) findings.push(`  ${f}: cancel-in-progress: ${cip} ${why}`);
}

if (findings.length) {
  console.error(`✗ main-runs-complete lint: ${findings.length} workflow(s) that can cancel a measurement of main mid-run:\n`);
  console.error(findings.join("\n"));
  console.error(
    `\nA run that measures main, or runs on a schedule, has to finish: a cancelled run posts no\n` +
      `verdict, and the next one starts over. Write the block form and say so:\n` +
      `  concurrency:\n    group: <name>\n    cancel-in-progress: false\n` +
      `(or ci.yml's conditional, \${{ github.ref != 'refs/heads/main' }}, when PR refs may cancel).\n`,
  );
  process.exit(1);
}
console.log("lint:main-runs-complete ✓ every scheduled or main-push workflow runs to completion.");
