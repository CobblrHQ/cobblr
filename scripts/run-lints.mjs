#!/usr/bin/env node
// Run EVERY lint:* script, concurrently, in ONE step.
//
// DISCOVERY IS BY package.json, deliberately — same property as run-unit-tests.mjs.
// There is no list to forget to update: a new `lint:*` script runs because it
// exists. That is what makes `lint:lints-are-wired` cheap to satisfy and hard to
// regress; before this, wiring a lint meant remembering to paste a step into
// ci.yml, and two lints shipped orphaned because nobody did.
//
// The lints are independent, read-only and short, so they parallelise perfectly.
// Their cost is almost entirely process startup: ~90 of them at ~600ms of
// pnpm + tsx boot each is ~70s serialised, ~10s at 8-wide.
//
//   node scripts/run-lints.mjs            (pnpm run lint:all)
//   node scripts/run-lints.mjs --only isolation,docs
//   COBBLR_LINT_CONCURRENCY=4 pnpm run lint:all

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConcurrency, runParallel } from "./lib/parallel.mjs";
import { CEILING_MS, judgeRun } from "./lib/lint-budget.mjs";
import { writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lints this runner deliberately does NOT run. Each needs a reason — "we never
 * got round to it" is not one, and an entry here is a standing invitation to
 * argue. `lint:lints-are-wired` reads this list, so a lint listed here is
 * accounted for rather than reported as an orphan.
 */
export const MANUAL = {
  "lint:pdf-bench":
    "renders PDFs and compares ink coverage, so its baseline is font- and " +
    "renderer-sensitive; in CI it would report label regressions that are really " +
    "container font differences. Run it locally when changing label layout.",
  "lint:branch-live":
    "asks the Forgejo API whether THIS branch's PR is still open — it is a " +
    "pre-push guard against building on a spent branch, and has no meaning in a " +
    "CI job that already checked the branch out.",
  "lint:all": "this runner",
};

/** Every lint:* script in the root package.json that this runner should execute. */
export function discoverLints() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return {
    all: Object.keys(pkg.scripts).filter((s) => s.startsWith("lint:")),
    run: Object.keys(pkg.scripts).filter((s) => s.startsWith("lint:") && !(s in MANUAL)),
    scripts: pkg.scripts,
  };
}

function main() {
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg === -1 ? null : new Set((process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean));
  // --record: write this run's per-lint times as the quiet baseline the budget
  // judges against. Refused for a partial run or a contended one (below).
  const record = process.argv.includes("--record");
  const SNAPSHOT = join(ROOT, "scripts", "lint-durations.json");
  let quietMs = {};
  try {
    quietMs = JSON.parse(readFileSync(SNAPSHOT, "utf8")).ms ?? {};
  } catch {
    /* no snapshot: every lint is "unknown" and the budget says so */
  }

  const { run, scripts } = discoverLints();
  const names = only ? run.filter((n) => only.has(n) || only.has(n.slice("lint:".length))) : run;

  if (names.length === 0) {
    console.error("[lints] no lint:* scripts matched — the discovery is broken, which is worse than a red lint.");
    process.exitCode = 1;
    return;
  }

  const concurrency = Number(process.env.COBBLR_LINT_CONCURRENCY) || defaultConcurrency();
  console.log(`[lints] ${names.length} lints, ${concurrency} at a time`);

  // Run the slowest first: a long job started last is dead wall-clock while the
  // pool drains. The order is a hint only — a lint that gets slower just drifts
  // down the list, it never breaks the run. Refresh it from a CI log's
  // "slowest:" line when it stops matching reality; the budget in
  // lib/lint-budget.mjs is what actually holds the line.
  const SLOWEST_FIRST = [
    "lint:staged-docs-reachable",
    "lint:bundle-schema",
    "lint:pg-readiness",
    "lint:hook-timeouts",
    "lint:no-emdash",
    "lint:isolation",
    "lint:instance-move",
    "lint:shot-guard",
    "lint:dead-exports",
    "lint:qr-token-parser",
    "lint:env-icons",
  ];
  const rank = (n) => (SLOWEST_FIRST.indexOf(n) === -1 ? SLOWEST_FIRST.length : SLOWEST_FIRST.indexOf(n));
  const jobs = names
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => ({ name, cmd: scripts[name], cwd: ROOT }));

  const started = Date.now();
  let done = 0;

  runParallel(jobs, {
    concurrency,
    onDone: (r) => {
      done++;
      const at = `[${String(done).padStart(String(jobs.length).length)}/${jobs.length}]`;
      if (r.code === 0) {
        console.log(`${at} ✓ ${r.name} (${r.ms}ms)`);
      } else {
        // Print the whole failure inline: this runner replaces ~50 CI steps, so
        // its log is the only place the cause can be read.
        console.log(`${at} ✗ ${r.name} (${r.ms}ms) — exit ${r.code}`);
        console.log(r.out.trimEnd().replace(/^/gm, "    "));
      }
    },
  }).then(async (results) => {
    // Under --record the baseline check is what the record satisfies, so a
    // stale baseline must not refuse the run that refreshes it: six unrecorded
    // lints once locked the two against each other, and no run could pass or
    // record (2026-09-14). It is re-checked against the written file below.
    const failed = results.filter((r) => r.code !== 0 && !(record && r.name === "lint:lint-durations"));
    const cpu = results.reduce((s, r) => s + r.ms, 0);
    const wall = Date.now() - started;
    const slowest = results
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((r) => `${r.name} ${(r.ms / 1000).toFixed(1)}s`)
      .join(", ");

    console.log(
      `\n[lints] ${results.length} lints in ${(wall / 1000).toFixed(1)}s wall ` +
        `(${(cpu / 1000).toFixed(1)}s serial) — slowest: ${slowest}`,
    );

    // Under --record the one lint that may fail is the one this run exists to
    // satisfy: lint:lint-durations says the snapshot is stale, and the snapshot
    // is what is about to be written. Refusing to record because it is stale
    // was a deadlock: the sixth unrecorded lint could never be recorded by the
    // documented command (2026-09-14).
    const blocking = record ? failed.filter((f) => f.name !== "lint:lint-durations") : failed;
    if (blocking.length) {
      console.error(`\n[lints] ✗ ${blocking.length} failing: ${blocking.map((f) => f.name).join(", ")}`);
      process.exitCode = 1;
      return;
    }

    // A GREEN lint that got slow is invisible: it passes, CI passes, and the
    // only symptom is the job creeping up. lint:ci-sink went from ~1s to 151s
    // (an unscoped `git grep -E` over a 94 MB tree) and spent eight days as the
    // ENTIRE lint suite's wall clock — 157s of 157s — while every run stayed
    // green. Nothing was watching the number, so now something is. Each lint
    // is judged against its own recorded quiet time, scaled by how contended
    // this run measurably was; a run too contended to judge says so and leaves
    // it to the next quiet one. lib/lint-budget.mjs has the numbers and the
    // two rules that failed before it.
    // A lint over its per-lint budget is run once more, ALONE, now that the
    // pool has drained: a stall (run 21374: a 0.4s lint at 12.8s because it
    // started in the compiler's wave) does not reproduce, a regression does.
    // Both numbers are printed so the log tells the story either way.
    const rerun = async (name) => {
      const [r] = await runParallel([{ name, cmd: scripts[name], cwd: ROOT }], { concurrency: 1 });
      return r.ms;
    };
    const { factor, contended, perLint, over, unknown, remeasured } = await judgeRun(results, quietMs, record ? null : rerun);
    const factorLine = `this run ran at ${factor.toFixed(2)}x the recorded quiet baseline`;
    if (contended) {
      console.log(`[lints] contended run (${factorLine}): per-lint budgets deferred to the next quiet run; only the hard ceiling applies here`);
    } else if (perLint) {
      console.log(`[lints] budget: ${factorLine}; every lint judged against its own quiet time`);
    }
    for (const m of remeasured) {
      console.log(`[lints] re-measured alone: ${m.name} ${(m.pooledMs / 1000).toFixed(1)}s in the pool, ${(m.aloneMs / 1000).toFixed(1)}s alone: ${m.verdict}`);
    }
    if (unknown.length) {
      console.log(`[lints] ${unknown.length} lint(s) not in scripts/lint-durations.json (judged at the snapshot median): ${unknown.join(", ")}\n        Record them: node scripts/run-lints.mjs --record   (on an idle machine)`);
    }
    // --record exists so a justified cost can be written down in the same
    // change; the per-lint judgement would refuse exactly that run, so under
    // --record it is reported, not enforced. The ceiling still is: a lint that
    // IS the CI job is not a baseline.
    const overCeiling = over.filter((r) => r.budgetMs === CEILING_MS);
    const overRatio = over.filter((r) => r.budgetMs !== CEILING_MS);
    if (record && overRatio.length) {
      console.log(
        `[lints] --record: ${overRatio.length} lint(s) over their previous budget, becoming the new baseline:\n` +
          overRatio.map((r) => `    ${r.name}  ${(r.ms / 1000).toFixed(1)}s — ${r.why}`).join("\n"),
      );
    }
    if (record ? overCeiling.length : over.length) {
      const shown = record ? overCeiling : over;
      console.error(
        `\n[lints] ✗ ${shown.length} lint(s) over budget:\n` +
          shown.map((r) => `    ${r.name}  ${(r.ms / 1000).toFixed(1)}s — ${r.why}`).join("\n") +
          `\n\n  A single lint this slow becomes the whole CI job. Make it cheaper — the usual\n` +
          `  cause is scanning the tree the expensive way (prefer \`git grep -F\` over a regex\n` +
          `  that starts matching at every byte, and scope the pathspec). If the cost is\n` +
          `  genuinely justified, re-record the baseline in the same change\n` +
          `  (node scripts/run-lints.mjs --record, on an idle machine) so it stays a\n` +
          `  decision someone made rather than drift nobody saw.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (record) {
      if (only) {
        console.error("[lints] --record refused: a partial run (--only) is not a baseline for the suite.");
        process.exitCode = 1;
        return;
      }
      if (contended) {
        console.error(`[lints] --record refused: ${factorLine}; a contended run is not a quiet baseline. Try again when the machine is idle.`);
        process.exitCode = 1;
        return;
      }
      const ms = Object.fromEntries(results.map((r) => [r.name, r.ms]).sort(([a], [b]) => a.localeCompare(b)));
      const doc = {
        recorded: new Date().toISOString().slice(0, 10),
        source: `run-lints.mjs --record (${results.length} lints, ${(wall / 1000).toFixed(1)}s wall, ${concurrency} at a time)`,
        note: "Quiet per-lint wall time in ms. Refresh: node scripts/run-lints.mjs --record on an idle machine (refused when the run is contended). Read by scripts/lib/lint-budget.mjs.",
        ms,
      };
      writeFileSync(SNAPSHOT, JSON.stringify(doc, null, 2) + "\n");
      console.log(`[lints] recorded ${results.length} quiet baselines to scripts/lint-durations.json`);
      if (scripts["lint:lint-durations"]) {
        const [again] = await runParallel([{ name: "lint:lint-durations", cmd: scripts["lint:lint-durations"], cwd: ROOT }], { concurrency: 1 });
        if (again.code !== 0) {
          console.error(`[lints] ✗ lint:lint-durations still fails against the file just recorded`);
          process.exitCode = 1;
          return;
        }
      }
    }

    console.log(`[lints] ✓ all ${results.length} pass`);
    // Record that this exact tree passed, so a push moments later does not redo
    // 180 lints while other agents are fighting for the same cores.
    try {
      execFileSync("node", [join(ROOT, "scripts", "verify-cache.mjs"), "stamp", "lints"], { cwd: ROOT });
    } catch {
      /* the cache is an optimisation — never fail a green lint run over it */
    }
  });
}

// Importable (lint:lints-are-wired reads MANUAL + discoverLints) without running.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
