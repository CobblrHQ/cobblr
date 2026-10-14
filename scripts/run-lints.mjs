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
// Their cost is almost entirely process startup, which is why each runs on
// plain node (~0.1 s to start) rather than tsx (~1.3 s): lib/lint-command.mjs.
//
//   node scripts/run-lints.mjs            (pnpm run lint:all)
//   node scripts/run-lints.mjs --one isolation [args]   (pnpm lint isolation): one lint, its own output and exit code
//   node scripts/run-lints.mjs --only isolation,docs
//   COBBLR_LINT_CONCURRENCY=4 pnpm run lint:all

import { readPathMs, readQuietMs, readRecordedReadMB, readRegistry, writeQuietMs } from "./lib/lint-durations.mjs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConcurrency, runParallel } from "./lib/parallel.mjs";
import { lintCommand } from "./lib/lint-command.mjs";
import { workingTreePaths } from "./lib/git-porcelain.mjs";
import { fetchManifests, latestPasses, lintRoots, lintRootsKey, lintSalt, mergeManifest, rootIds, rootsUnchanged, verdictMode } from "./lib/lint-verdicts.mjs";
import { record as recordVerdicts, recordShadow } from "./lib/verdict-cache.mjs";
import { CEILING_MS, quietFor, judgeRun, ioPressure, IO_CONTENDED_AT, cpuPressure, CPU_CONTENDED_AT, overReadBudget } from "./lib/lint-budget.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EMBEDDED_PAYLOADS, PAYLOAD_READERS } from "./lib/embedded-payloads.mjs";
import { tmpdir } from "node:os";

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
    execFileSync("bash", ["-c", `${lintCommand(cmd)}${quoted ? ` ${quoted}` : ""}`], { cwd: ROOT, stdio: "inherit", env: { ...process.env, PATH: `${join(ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}` } });
  } catch (e) {
    process.exitCode = typeof e?.status === "number" ? e.status : 1;
  }
}

async function main() {
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
  // --reuse-ci (the pre-push hook, #5761): a lint whose every root has the very object id it had when it
  // last passed in CI is not run here; CI runs every lint anyway. Fails open: no store, no ids, any error.
  const reuseCi = process.argv.includes("--reuse-ci") && !record && !only;
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

  // THE VERDICT CACHE (#4303, lib/lint-verdicts.mjs v2, #5761): a lint whose every root (each file it
  // read, loaded or probed, each directory it listed, globbed or asked git about) has the object id it had
  // when the lint last passed, and whose variables are as they were, is not run again. One
  // `git cat-file --batch-check` keys the suite (v1 replayed every observation: 644 s, 2026-10-10).
  // The mode (lib/lint-verdicts.mjs verdictMode): "on" reuses, a pull request's default since a day of
  // shadow runs showed no miss; "shadow" keys every lint, says what it would reuse, runs them all and
  // reports any would-be reuse that failed, main's default so it stays the backstop; "off" does nothing.
  // Never --record or --only. Fails open: no store, a dirty tree, any error: every lint runs.
  const { mode, shadow } = verdictMode(process.env);
  const cacheOn = (process.env.CI || process.env.COBBLR_VERDICT_FORCE) && (mode === "on" || mode === "shadow") && !record && !only;
  let vctx = null;
  /** @type {Map<string, string>} lint -> the run its reusable pass came from */
  const reusable = new Map();
  let reusedNames = [];
  if (cacheOn) {
    try {
      execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: ROOT, stdio: "ignore" });
      vctx = { root: ROOT, salt: lintSalt(ROOT), sources: new Map() };
    } catch {
      console.log("[verdicts] off: the working tree's tracked files differ from HEAD");
    }
    if (vctx) {
      const t0 = Date.now();
      // THE CACHE NEVER COSTS MORE THAN IT SAVES: keying has a deadline, past which it gives up and every lint
      // runs, as on any other error. On a box without /ts-cache it fetched ~1,400 manifests one by one and
      // keyed for 832 s before 59 s of lints (run 45526, #5761); 46 of aurora's 135 runs in two days.
      const deadline = t0 + Number(process.env.COBBLR_VERDICT_KEY_BUDGET_MS || 60_000);
      const latest = await latestPasses(names);
      const manifests = await fetchManifests(Object.values(latest).flat().map((p) => p.manifest), { deadline, dir: process.env.COBBLR_VERDICT_MANIFESTS || (existsSync("/ts-cache") ? "/ts-cache/lint-manifests-v2" : undefined) });
      const candidates = [];
      for (const n of names) for (const pass of latest[n] ?? []) {
        const m = manifests.get(pass.manifest);
        if (m?.v === 2) candidates.push({ n, pass, roots: m });
      }
      const ids = rootIds(ROOT, candidates.flatMap((c) => [...c.roots.dirs, ...c.roots.files, ...(c.roots.probes ?? [])]));
      for (const { n, pass, roots } of candidates) {
        if (reusable.has(n)) continue;
        const { key } = lintRootsKey({ name: n, cmd: scripts[n], roots, salt: vctx.salt, ids, root: ROOT, sources: vctx.sources });
        if (key && key === pass.key) reusable.set(n, pass.run);
      }
      const ms = Date.now() - t0;
      if (Date.now() > deadline) {
        console.log(`[verdicts] off: keying ran past its ${((deadline - t0) / 1000).toFixed(0)} s budget (${(ms / 1000).toFixed(1)} s, ${manifests.size} manifests fetched); every lint runs`);
        reusable.clear();
      } else if (shadow) console.log(`[verdicts] shadow: every lint runs; ${reusable.size} of ${names.length} would have been reused (keyed in ${(ms / 1000).toFixed(1)}s), and any of those that fails is a shadow miss`);
      else {
        reusedNames = [...reusable.keys()];
        const byRun = new Map();
        for (const r of reusable.values()) byRun.set(r, (byRun.get(r) ?? 0) + 1);
        console.log(`[verdicts] reused ${reusedNames.length} of ${names.length} lints: every root each observed is as it was when it passed (from run${byRun.size === 1 ? "" : "s"} ${[...byRun].map(([r, n]) => `${r || "?"} (${n})`).join(", ") || "-"}; keyed in ${(ms / 1000).toFixed(1)}s)`);
        if (reusedNames.length) console.log(`[verdicts]   reused: ${reusedNames.sort().join(", ")}`);
      }
    }
  }
  if (reuseCi && !cacheOn) {
    try {
      const t0 = Date.now();
      const latest = await latestPasses(names);
      const manifests = await fetchManifests(Object.values(latest).flat().map((p) => p.manifest), { deadline: t0 + 30_000 });
      const candidates = [];
      for (const n of names) for (const pass of latest[n] ?? []) {
        const m = manifests.get(pass.manifest);
        if (m?.v === 2 && m.ids && !m.hidden?.length) candidates.push({ n, pass, m });
      }
      const now = rootIds(ROOT, candidates.flatMap((c) => Object.keys(c.m.ids)));
      for (const { n, pass, m } of candidates) {
        if (reusable.has(n)) continue;
        if (rootsUnchanged(m, now)) reusable.set(n, pass.run);
      }
      reusedNames = [...reusable.keys()];
      console.log(`[lints] ${reusedNames.length} of ${names.length} lints reused: every root each read is as it was when it passed in CI (checked in ${((Date.now() - t0) / 1000).toFixed(1)}s); CI runs them all anyway`);
    } catch (e) {
      console.log(`[lints] could not compare with CI's passes (${e.message}); every lint runs`);
    }
  }
  const toRun = reusedNames.length ? names.filter((n) => !reusable.has(n)) : names;
  if (toRun.length === 0) {
    console.log(`[lints] ✓ every lint's verdict was reused; nothing to run`);
    return;
  }

  const concurrency = Number(process.env.COBBLR_LINT_CONCURRENCY) || defaultConcurrency();
  console.log(`[lints] ${toRun.length} lints, ${concurrency} at a time`);

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
  // Every lint's reads are counted (lib/lint-reads.cjs), one file per lint.
  const readsDir = mkdtempSync(join(tmpdir(), "lint-reads-"));
  // One file per lint, ~370 inodes a run, on every push, CI job and merge
  // probe: never removed, it was the largest share of the inodes that filled
  // the runner host's /tmp on 2026-09-30. Gone when the run ends, however it ends.
  process.once("exit", () => rmSync(readsDir, { recursive: true, force: true }));
  const readsFile = (name) => join(readsDir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
  const inputsFile = (name) => join(readsDir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.inputs.jsonl`);
  // THE PRE-PUSH RUN COSTS THE SIZE OF THE CHANGE (#6226). A per-file lint (scripts/lib/lint-only-files.ts) checks
  // only the files this change touches: committed since the merge base with main, plus the working tree. CI runs
  // every lint over the whole tree after, so this narrows the push, never the gate. No merge base: no list, and
  // every lint reads everything as before.
  let onlyFiles = null;
  if (reuseCi) {
    try {
      const mb = ["origin/main", "forgejo/main", "main"].map((r) => {
        try {
          return execFileSync("git", ["merge-base", "HEAD", r], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        } catch {
          return "";
        }
      }).find(Boolean);
      if (mb) {
        const committed = execFileSync("git", ["diff", "--name-only", `${mb}...HEAD`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 }).split("\n").filter(Boolean);
        const changed = [...new Set([...committed, ...workingTreePaths(ROOT)])];
        onlyFiles = join(readsDir, "only-files.txt");
        writeFileSync(onlyFiles, `${changed.join("\n")}\n`);
        console.log(`[lints] per-file lints check the ${changed.length} file(s) this change touches; CI checks the whole tree`);
      }
    } catch (e) {
      console.log(`[lints] could not list this change's files (${e?.message ?? e}); every lint reads the whole tree`);
      onlyFiles = null;
    }
  }
  const preload = `--require ${join(ROOT, "scripts", "lib", "lint-reads.cjs")}${vctx ? ` --require ${join(ROOT, "scripts", "lib", "lint-inputs.cjs")}` : ""}`;
  const jobs = toRun
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => ({
      name,
      cmd: lintCommand(scripts[name]),
      cwd: ROOT,
      env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} ${preload}`.trim(), COBBLR_LINT_READS_FILE: readsFile(name), ...(onlyFiles ? { COBBLR_LINT_ONLY_FILES: onlyFiles } : {}), COBBLR_LINT_PAYLOADS: JSON.stringify(EMBEDDED_PAYLOADS), ...(PAYLOAD_READERS.includes(name) ? { COBBLR_LINT_READ_PAYLOADS: "1" } : {}), ...(vctx ? { COBBLR_LINT_INPUTS_FILE: inputsFile(name), COBBLR_LINT_ROOT: ROOT } : {}) },
    }));
  const readMBOf = (name, key = "bytes") => {
    try {
      let bytes = 0;
      for (const line of readFileSync(readsFile(name), "utf8").split("\n")) if (line.trim()) bytes += JSON.parse(line)[key] ?? 0;
      return bytes / 1048576;
    } catch {
      return 0;
    }
  };

  const started = Date.now();
  // CPU pressure at both ends of the run: avg60 read only at the end would
  // miss a box that was starved while the slow lints ran and eased after.
  const cpuAtStart = cpuPressure();
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
    // Every lint that passed is stored with what it observed, whatever else failed; a failure never is.
    if (vctx) {
      const entries = [];
      let hiddenCount = 0;
      const hiddenWhy = new Map();
      const rootsOf = new Map();
      for (const r of results) {
        if (r.code !== 0) continue;
        let m;
        try {
          m = mergeManifest(readFileSync(inputsFile(r.name), "utf8"));
        } catch {
          m = mergeManifest("");
        }
        rootsOf.set(r.name, lintRoots(m));
      }
      const tk = Date.now();
      const ids = rootIds(ROOT, [...rootsOf.values()].flatMap((x) => [...x.dirs, ...x.files, ...(x.probes ?? [])]));
      const sizes = [...rootsOf].map(([n, x]) => [n, x.dirs.length + x.files.length + (x.probes ?? []).length]).sort((a, b) => a[1] - b[1]);
      const wholeTree = [...rootsOf.values()].filter((x) => x.dirs.includes(".")).length;
      if (sizes.length) console.log(`[verdicts] roots per lint: median ${sizes[Math.floor(sizes.length / 2)][1]}, max ${sizes.at(-1)[1]} (${sizes.at(-1)[0]}); ${wholeTree} read the whole tree; ${ids.size} ids in ${Date.now() - tk} ms`);
      for (const [name, roots] of rootsOf) {
        const { key, hidden } = lintRootsKey({ name, cmd: scripts[name], roots, salt: vctx.salt, ids, root: ROOT, sources: vctx.sources });
        if (!key) {
          hiddenCount++;
          hiddenWhy.set(hidden, (hiddenWhy.get(hidden) ?? 0) + 1);
          continue;
        }
        // The ids each root had: what the pre-push hook compares (--reuse-ci), since its salt is not CI's.
        const seen = Object.fromEntries([...roots.dirs, ...roots.files, ...(roots.probes ?? [])].map((r) => [r, ids.get(r)]));
        entries.push({ name, key, manifest: { v: 2, ...roots, ids: seen } });
      }
      const kept = await recordVerdicts("lint", entries);
      console.log(`[verdicts] ${kept ? "stored" : "could not store"} ${entries.length} lint pass(es) for the next run; ${hiddenCount} never reused`);
      for (const [why, n] of [...hiddenWhy].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`[verdicts]   never reused (${n}): ${String(why)}`);
      if (shadow && reusable.size) {
        const misses = results.filter((r) => r.code !== 0 && reusable.has(r.name)).map((r) => ({ name: r.name, from: reusable.get(r.name) }));
        if (misses.length) {
          console.error(`[verdicts] ✗ SHADOW MISS: the cache would have reused a pass for ${misses.length} lint(s) that failed here. Each is a hole in what lib/lint-inputs.cjs records:`);
          for (const m of misses) console.error(`[verdicts]     ${m.name} (its pass came from run ${m.from || "?"})`);
          await recordShadow("lint", misses);
        } else console.log(`[verdicts] shadow check: all ${reusable.size} lint(s) the cache would have reused passed here`);
      }
    }
    for (const r of results) {
      r.readMB = readMBOf(r.name);
      r.payloadMB = readMBOf(r.name, "payloadBytes");
    }
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
      const [r] = await runParallel([{ name, cmd: lintCommand(scripts[name]), cwd: ROOT }], { concurrency: 1 });
      return r.ms;
    };
    // The box's I/O pressure is the second axis of contention: a docker prune
    // stalls every file-reading lint while the CPU factor reads quiet.
    // And CPU pressure the third: other jobs starving the box slow every lint
    // here, the re-measure included, while this run's own factor reads 1.00x.
    const io = ioPressure();
    const cpuAtEnd = cpuPressure();
    const cpuPsi = cpuAtStart === null && cpuAtEnd === null ? null : Math.max(cpuAtStart ?? 0, cpuAtEnd ?? 0);
    const { factor, contended, perLint, over, unknown, remeasured, ioContended, cpuContended } = await judgeRun(results, quietFor(results, quietMs, readPathMs()), record ? null : rerun, { ioPressure: io, cpuPressure: cpuPsi });
    const factorLine =
      `this run ran at ${factor.toFixed(2)}x the recorded quiet baseline` +
      (io !== null ? `, I/O pressure ${io.toFixed(1)}%` : "") +
      (cpuPsi !== null ? `, CPU pressure ${cpuPsi.toFixed(1)}%` : "");
    if (contended) {
      const starved = [ioContended ? `I/O-starved, at or over ${IO_CONTENDED_AT}%` : "", cpuContended ? `CPU-starved, at or over ${CPU_CONTENDED_AT}%` : ""].filter(Boolean).join(" and ");
      console.log(`[lints] contended run (${factorLine}${starved ? `; the box is ${starved}` : ""}): per-lint budgets deferred to the next quiet run; only the hard ceiling applies here`);
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
    // The read budget: deterministic, so it is enforced on every run, contended
    // or not (lib/lint-budget.mjs). Under --record the reads become the record.
    const overRead = record ? [] : overReadBudget(results, readRecordedReadMB());
    if (overRead.length) {
      console.error(
        `\n[lints] ✗ ${overRead.length} lint(s) over their read budget:\n` +
          overRead
            .map((r) => {
              const payload = results.find((x) => x.name === r.name)?.payloadMB ?? 0;
              // The usual reason, named: a source walk that reads the base64 build.
              const why = payload >= 0.1 ? `\n      ${payload.toFixed(1)} MB of it is an embedded payload (${EMBEDDED_PAYLOADS.join(", ")}): it is one of PAYLOAD_READERS in scripts/lib/embedded-payloads.mjs; take it off unless it must read the payload` : "";
              return `    ${r.name}  ${r.why}${why}`;
            })
            .join("\n") +
          `\n\n  A lint that reads the whole tree to find one pattern, or re-reads a file per\n` +
          `  row or per variable, grows with the repo until it is the CI job. Read each file\n` +
          `  once, or let \`git grep -l -F <pattern>\` pick the files first. If the reads are\n` +
          `  justified, record them in the same change: node scripts/run-lints.mjs --record.\n`,
      );
      process.exitCode = 1;
      return;
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
      for (const r of results) writeQuietMs(r.name, r.ms, source, undefined, undefined, r.readMB);
      console.log(`[lints] recorded ${results.length} quiet baselines to scripts/lint-durations/`);
      if (scripts["lint:lint-durations"]) {
        const [again] = await runParallel([{ name: "lint:lint-durations", cmd: lintCommand(scripts["lint:lint-durations"]), cwd: ROOT }], { concurrency: 1 });
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
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
