// The per-lint wall-clock budget: what "this lint got slow" means on a machine
// whose speed changes from run to run.
//
// TWO RULES FAILED BEFORE THIS ONE, both on the same day, both on contention:
//
//   1. A fixed 45s. Three agents pushing at once took a compiler-cost lint from
//      16s to 58s on a change that touched nothing; the fix was a 150s override
//      and a trap-list line telling builders to read "over the budget" as noise.
//   2. A ratio of the run's own median (#2924). The median does not move under
//      load: 200 of the 250 lints are process-startup-bound at ~0.5s and stay
//      there, so the median sat at 0.69s while the lints that do real work
//      scaled 2.2x and a stalled one scaled 59x. Red on main within the hour.
//
// WHAT THE DATA SAYS (CI runs 21205 quiet vs 21210 contended, 2026-09-13):
//   - quiet vs quiet, per lint: p50 0.94x, p95 1.32x, max 2.05x. A per-lint
//     baseline from a quiet run is TIGHT.
//   - contended vs quiet, the lints over 2s quiet (the ones that scale with
//     the machine): 0.5x to 2.2x, median 1.6x. That median is the run's
//     contention factor, and it is measurable from the run itself.
//   - contended vs quiet, everything: p95 3.9x, p99 6.2x, and two STALLS at
//     19x and 59x (changelog-names-ui 13s, fixtures-tracked 34s; both 0.5s
//     the next run). Under load a single lint can stall for half a minute on
//     scheduling or IO alone. No per-lint number, however scaled, separates
//     that stall from a regression in the same run.
//
// THE RULE:
//   - The baseline is PER LINT, from the recorded quiet run in
//     scripts/lint-durations.json (refreshed with `run-lints.mjs --record` on an
//     idle machine; refused when the run is contended).
//   - The run's contention FACTOR is the median of (now / quiet) over the lints
//     with a quiet time of at least SCALING_MS: those are the ones that follow
//     the machine. Never below 1 (a faster machine does not tighten budgets).
//   - A QUIET run (factor at or under CONTENDED_AT) judges every lint against
//     quiet_i * factor * MARGIN + FLOOR_MS. The floor is what absorbs a stall
//     the factor cannot see: the factor is a median over ~11 lints and reads
//     1.0 on runs where one 0.9s lint took 6s (feature-defaults, run 21246)
//     and the compiler lint took 13s longer. Swept over ten real runs with
//     MARGIN 3: a 2s floor fails five of them on noise, 5s fails four, 10s
//     fails none. So a 0.5s lint has to reach ~11s to be called a regression
//     on a quiet run; that is the sensitivity this runner's noise allows, and
//     a lint that adds ten seconds serial is what "became the CI job" starts
//     to look like. (fixtures-tracked, the lint behind four of those five,
//     was walking node_modules; that was a real cost bug and was fixed.)
//   - A CONTENDED run cannot judge a single lint (see the stalls), and the rule
//     says so rather than pretending: only the hard CEILING applies, the runner
//     prints the factor and that per-lint budgets are deferred, and the next
//     quiet run (most runs are quiet) judges them. A regression big enough to
//     BE the CI job is caught on any machine by the ceiling. A lint over the
//     ceiling whose QUIET time says it cannot be the job (quiet * MARGIN under
//     the ceiling) is re-measured alone once, on any run: run 22733 (2026-09-17)
//     reddened main with every lint passing when a 2.70x load carried the
//     16.6s compiler lint to 127s. A stall does not reproduce alone; a
//     regression does, and still fails.
//   - A lint the snapshot has never heard of is judged against the snapshot's
//     median as its quiet time: a new lint is cheap or it is recorded, and
//     recording it is the decision. Nothing is fail-open.
//   - A run of fewer than MIN_SAMPLE lints (--only) has no factor worth
//     trusting; only the ceiling applies.
//
// The absolute number survives only as the CEILING: a lint over it fails on any
// machine because at that length it IS the CI job whatever the factor says. The
// known regression (ci-sink at 151s) trips it; the worst stall measured under
// a 3-job load (34s) does not.

export const MARGIN = 3;
export const FLOOR_MS = 10_000;
export const SCALING_MS = 2_000;
export const CONTENDED_AT = 1.5;
export const CEILING_MS = 120_000;
export const MIN_SAMPLE = 20;

export function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The run's contention factor: how much slower the lints that follow the
 *  machine ran than their quiet baseline. 1 when nothing can be compared. */
export function contentionFactor(results, quietMs, opts = {}) {
  const scalingMs = opts.scalingMs ?? SCALING_MS;
  const ratios = [];
  for (const r of results) {
    const q = quietMs[r.name];
    if (q && q >= scalingMs) ratios.push(r.ms / q);
  }
  if (ratios.length === 0) return 1;
  return Math.max(1, median(ratios));
}

/**
 * Judge one run. `results` is [{ name, ms }]; `quietMs` is the snapshot's
 * per-lint quiet time. Returns the factor, whether the run counted as
 * contended, every lint over its budget (slowest first, each with why), and
 * the lints the snapshot does not know.
 */
export function overBudget(results, quietMs = {}, opts = {}) {
  const margin = opts.margin ?? MARGIN;
  const floorMs = opts.floorMs ?? FLOOR_MS;
  const contendedAt = opts.contendedAt ?? CONTENDED_AT;
  const ceilingMs = opts.ceilingMs ?? CEILING_MS;
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const known = Object.values(quietMs);
  const unknownQuiet = median(known);
  const factor = contentionFactor(results, quietMs, opts);
  const sampled = results.length >= minSample && known.length > 0;
  const contended = sampled && factor > contendedAt;
  const perLint = sampled && !contended;
  const over = [];
  const unknown = [];
  for (const r of results) {
    const q = quietMs[r.name];
    if (!q) unknown.push(r.name);
    const quiet = q || unknownQuiet;
    const budget = perLint ? quiet * factor * margin + floorMs : Infinity;
    if (r.ms > ceilingMs) {
      over.push({ name: r.name, ms: r.ms, budgetMs: ceilingMs, why: `over the ${ceilingMs / 1000}s hard ceiling` });
    } else if (r.ms > budget) {
      over.push({
        name: r.name,
        ms: r.ms,
        budgetMs: budget,
        why:
          `${(r.ms / quiet).toFixed(1)}x its quiet ${(quiet / 1000).toFixed(2)}s` +
          (q ? "" : " (not in the snapshot; the snapshot median stands in)") +
          ` on a run at ${factor.toFixed(2)}x (limit ${(budget / 1000).toFixed(1)}s)`,
      });
    }
  }
  over.sort((a, b) => b.ms - a.ms);
  return { factor, contended, perLint, over, unknown };
}

/**
 * Judge a run, re-measuring alone any lint over its per-lint budget.
 *
 * A stall does not reproduce: run 21374 read as quiet (factor 1.09) while two
 * 0.4s lints that started in the same wave as the compiler took 11-13s, and
 * no floor sized on the runs before it would have absorbed that (6s, then
 * 12.8s, then 33.6s: the tail grows every time it is measured). A regression
 * does reproduce. So a lint over its per-lint budget is run again, alone, once
 * the pool has drained, and judged on that time; both numbers are kept so the
 * log tells the story. The ceiling is never re-measured (a lint that IS the CI
 * job is not a stall) and a contended run still defers: this sits inside the
 * quiet-run path only.
 *
 * The ceiling is re-measured too, on any run, for a lint whose quiet time
 * says it could not be the job (quiet * MARGIN under the ceiling): run 22733
 * reddened main on a 16.6s lint at 127s under a 2.7x load. One the snapshot
 * does not know, or whose quiet time is within the margin, is the job and
 * fails on the first measurement.
 *
 * `rerun(name)` resolves to the lint's wall time in ms when run alone.
 */
export async function judgeRun(results, quietMs = {}, rerun, opts = {}) {
  const ceilingMs = opts.ceilingMs ?? CEILING_MS;
  const margin = opts.margin ?? MARGIN;
  const first = overBudget(results, quietMs, opts);
  // A per-lint budget miss is re-measured on a quiet run only. The CEILING
  // is re-measured on any run, once, for a lint whose own quiet time says it
  // cannot be the job: main went red at 866dc0f4e (run 22733) with every
  // lint passing, when a 2.70x contended run carried scripts-typecheck (16.6s
  // quiet) to 127.3s. A 16s lint at 7.7x is the stall shape the header
  // measures under load, and the only remedy was the re-run button. A lint
  // the snapshot has never heard of, or whose quiet time is already within
  // the margin of the ceiling, IS the job when it crosses it (ci-sink at
  // 151s) and fails without a second look.
  const couldNotBeTheJob = (name) => {
    const q = quietMs[name];
    return !!q && q * margin < ceilingMs;
  };
  const stalled = rerun
    ? first.over.filter((r) => (r.budgetMs === ceilingMs ? couldNotBeTheJob(r.name) : first.perLint))
    : [];
  if (stalled.length === 0) return { ...first, remeasured: [] };
  const alone = {};
  for (const r of stalled) alone[r.name] = await rerun(r.name);
  const updated = results.map((r) => (r.name in alone ? { ...r, ms: alone[r.name] } : r));
  const final = overBudget(updated, quietMs, opts);
  const stillOver = new Set(final.over.map((r) => r.name));
  const remeasured = stalled.map((r) => ({
    name: r.name,
    pooledMs: r.ms,
    aloneMs: alone[r.name],
    verdict: stillOver.has(r.name) ? "over budget" : "a stall",
  }));
  const pooled = Object.fromEntries(stalled.map((r) => [r.name, r.ms]));
  final.over = final.over.map((r) =>
    r.name in alone ? { ...r, why: `${(pooled[r.name] / 1000).toFixed(1)}s in the pool, ${(alone[r.name] / 1000).toFixed(1)}s alone: ${r.why}` } : r,
  );
  return { ...final, remeasured };
}
