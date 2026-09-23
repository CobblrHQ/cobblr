#!/usr/bin/env node
// Run EVERY registered lint, concurrently, in ONE step.
//
// DISCOVERY IS BY THE LINT'S OWN RECORD, scripts/lint-durations/<name>.json
// (#3455): its "run" command, beside its quiet time. There is no list to
// forget to update, and no shared list to conflict in: a lint is its script
// and its record, two new files. It used to be a `lint:*` line in
// package.json, which every branch adding a lint appended to, so any two such
// branches conflicted there by construction. Before THAT, wiring a lint meant
// pasting a step into ci.yml, and two lints shipped orphaned.
//
// The lints are independent, read-only and short, so they parallelise perfectly.
// Their cost is almost entirely process startup: ~90 of them at ~600ms of
// pnpm + tsx boot each is ~70s serialised, ~10s at 8-wide.
//
//   node scripts/run-lints.mjs            (pnpm run lint:all)
//   node scripts/run-lints.mjs --one isolation [args]   (pnpm lint isolation): one lint, its own output and exit code
//   node scripts/run-lints.mjs --only isolation,docs
//   COBBLR_LINT_CONCURRENCY=4 pnpm run lint:all

import { readFileSync } from "node:fs";
import { readQuietMs, readRegistry, writeQuietMs } from "./lib/lint-durations.mjs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConcurrency, runParallel } from "./lib/parallel.mjs";
import { CEILING_MS, judgeRun, ioPressure, IO_CONTENDED_AT } from "./lib/lint-budget.mjs";
import { writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lints this runner deliberately does NOT run, each with its reason, read from
 * its record's "manual" field. `lint:lints-are-wired` holds that every one has
 * a reason and every other registered lint runs.
 */
export const MANUAL = Object.fromEntries(readRegistry().filter((l) => l.manual).map((l) => [l.name, l.manual]));

/** Every registered lint, and the ones this runner executes. */
export function discoverLints() {
  const reg = readRegistry();
  return {
    all: reg.map((l) => l.name),
    run: reg.filter((l) => !l.manual).map((l) => l.name),
    scripts: Object.fromEntries(reg.map((l) => [l.name, l.run])),
  };
}

/** `pnpm lint <name> [args]`: run ONE registered lint, manual ones included,
 *  with its own output and exit code. Replaces the `pnpm run lint:<name>`
 *  that each package.json entry used to give. */
function runOne(rawName, args) {
  const name = String(rawName ?? "").startsWith("lint:") ? String(rawName) : `lint:${rawName ?? ""}`;
  const { scripts } = discoverLints();
  const cmd = scripts[name];
  if (!rawName || !cmd) {
    const near = Object.keys(scripts).filter((n) => rawName && n.includes(String(rawName))).slice(0, 8);
    console.error(`[lints] ${rawName ? `no registered lint "${name}"` : "usage: pnpm lint <name> [args]"}${near.length ? `; did you mean: ${near.map((n) => n.slice(5)).join(", ")}` : ""}`);
    console.error("        A lint is registered by its record, scripts/lint-durations/<name>.json (scripts/new-lint.sh makes one).");
    process.exitCode = 2;
    return;
  }
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
  try {
    execFileSync("bash", ["-c", `${cmd}${quoted ? ` ${quoted}` : ""}`], { cwd: ROOT, stdio: "inherit", env: { ...process.env, PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}` } });
  } catch (e) {
    process.exitCode = typeof e?.status === "number" ? e.status : 1;
  }
}

function main() {
  const oneArg = process.argv.indexOf("--one");
  if (oneArg !== -1) {
    // `pnpm lint no-emdash -- --update`: pnpm passes the separator through.
    const rest = process.argv.slice(oneArg + 2);
    return runOne(process.argv[oneArg + 1], rest[0] === "--" ? rest.slice(1) : rest);
  }
  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg === -1 ? null : new Set((process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean));
  // --record: write this run's per-lint times as the quiet baseline the budget
  // judges against. Refused for a partial run or a contended one (below).
  const record = process.argv.includes("--record");
  // One file per lint (scripts/lint-durations/), read through the one module
  // so the shape cannot drift: a shared map let a merge drop an entry in
  // silence, and its pressure valve is what hid it (#3447).
  const quietMs = readQuietMs();

  const { run, scripts } = discoverLints();
  const names = only ? run.filter((n) => only.has(n) || only.has(n.slice("lint:".length))) : run;

  if (names.length === 0) {
    console.error("[lints] no registered lints matched: the discovery is broken, which is worse than a red lint.");
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
    // The box's I/O pressure is the second axis of contention: a docker prune
    // stalls every file-reading lint while the CPU factor reads quiet.
    const io = ioPressure();
    const { factor, contended, perLint, over, unknown, remeasured, ioContended } = await judgeRun(results, quietMs, record ? null : rerun, { ioPressure: io });
    const factorLine = `this run ran at ${factor.toFixed(2)}x the recorded quiet baseline` + (io !== null ? `, I/O pressure ${io.toFixed(1)}%` : "");
    if (contended) {
      console.log(`[lints] contended run (${factorLine}${ioContended ? `; the box is I/O-starved, at or over ${IO_CONTENDED_AT}%` : ""}): per-lint budgets deferred to the next quiet run; only the hard ceiling applies here`);
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
      const source = `run-lints.mjs --record (${results.length} lints, ${(wall / 1000).toFixed(1)}s wall, ${concurrency} at a time)`;
      for (const r of results) writeQuietMs(r.name, r.ms, source);
      console.log(`[lints] recorded ${results.length} quiet baselines to scripts/lint-durations/`);
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
