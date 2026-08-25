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

  const { run, scripts } = discoverLints();
  const names = only ? run.filter((n) => only.has(n) || only.has(n.slice("lint:".length))) : run;

  if (names.length === 0) {
    console.error("[lints] no lint:* scripts matched — the discovery is broken, which is worse than a red lint.");
    process.exit(1);
  }

  const concurrency = Number(process.env.COBBLR_LINT_CONCURRENCY) || defaultConcurrency();
  /** Per-lint ceiling. No single check may quietly become the CI job (see below). */
  const BUDGET_MS = Number(process.env.COBBLR_LINT_BUDGET_MS) || 45_000;
  console.log(`[lints] ${names.length} lints, ${concurrency} at a time`);

  // Run the slowest first: a long job started last is dead wall-clock while the
  // pool drains. The order is a hint only — a lint that gets slower just drifts
  // down the list, it never breaks the run. Refresh it from a CI log's
  // "slowest:" line when it stops matching reality; BUDGET_MS below is what
  // actually holds the line.
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
  }).then((results) => {
    const failed = results.filter((r) => r.code !== 0);
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

    if (failed.length) {
      console.error(`\n[lints] ✗ ${failed.length} failing: ${failed.map((f) => f.name).join(", ")}`);
      process.exit(1);
    }

    // A GREEN lint that got slow is invisible: it passes, CI passes, and the
    // only symptom is the job creeping up. lint:ci-sink went from ~1s to 151s
    // (an unscoped `git grep -E` over a 94 MB tree) and spent eight days as the
    // ENTIRE lint suite's wall clock — 157s of 157s — while every run stayed
    // green. Nothing was watching the number, so now something is. The budget is
    // ~6x the whole suite's normal wall, well clear of runner contention: the
    // second-slowest lint in that same run was 9s.
    const over = results.filter((r) => r.ms > BUDGET_MS).sort((a, b) => b.ms - a.ms);
    if (over.length) {
      console.error(
        `\n[lints] ✗ ${over.length} lint(s) over the ${(BUDGET_MS / 1000).toFixed(0)}s budget:\n` +
          over.map((r) => `    ${r.name}  ${(r.ms / 1000).toFixed(1)}s`).join("\n") +
          `\n\n  A single lint this slow becomes the whole CI job. Make it cheaper — the usual\n` +
          `  cause is scanning the tree the expensive way (prefer \`git grep -F\` over a regex\n` +
          `  that starts matching at every byte, and scope the pathspec). If the cost is\n` +
          `  genuinely justified, raise BUDGET_MS in scripts/run-lints.mjs in the same change,\n` +
          `  so it stays a decision someone made rather than drift nobody saw.\n`,
      );
      process.exit(1);
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
