#!/usr/bin/env node
// Writes .forgejo/workflows/ci-main.yml from ci.yml: the same CI, for pushes
// to main, on runner labels only main's pushes use.
//
// WHY. Main's own typecheck and test used to queue behind every pull
// request's, because they asked for the same labels (`light`, `ci-test`).
// The 04:00 release takes the newest GREEN main commit, and on 2026-09-30
// main's runs sat pending behind a 150-job PR queue: the cut nearly skipped a
// day carrying two security fixes. A lane only main uses fixes the order.
// Forgejo 15 does not evaluate `github.*` in `runs-on` (a probe on a pull
// request got the expression's fallback label), so the lane cannot be one
// job switching labels on the event: it is a second workflow. And it is
// GENERATED, so the gate cannot drift into a third hand-kept copy of the
// suite beside ci.yml and ci-tracker.yml's test-full.
//
// A RECHECK DOES NOT RIDE THIS LANE (the direct merge policy, #5738): main plus a pull request whose
// files main changed since its green run, pushed as recheck/<pr>-<head12>, runs ci-recheck.yml on the
// pull request lane's labels (RECHECK below).
//
// What differs from ci.yml, and nothing else:
//   - on: push to main and bisect/** (bisect: one untested merge under a red
//     tip, tested on its own: scripts/ci/red-main-culprit.mjs), with ci.yml's
//     pull_request paths-ignore;
//   - concurrency: one group per ref and commit, never cancelled. A main commit
//     that is no longer the tip when its jobs start stands them down instead
//     (scripts/ci/stand-down-if-superseded.sh), so only main's newest commit is
//     tested, and a red tip names its culprit by testing the merges it skipped;
//   - runs-on: pr-check -> light-main, ci-test -> ci-main.
// `name: CI` stays, so the status contexts stay `CI / typecheck (push)` and
// `CI / test (push)`, which the release, merge-pr and deploy read.
//
// THE FAST LANE IS GENERATED HERE TOO (#4343): ci-fast.yml is the same CI for a push to
// fast/<pr> (main plus one critical pull request, pushed by scripts/ci/fast-lane.mjs), on
// labels only the reserved fast runner carries (pr-check -> fast-light, ci-test -> fast-test),
// plus one last job that writes its verdicts onto the pull request's head.
//
//   node scripts/gen-ci-main.mjs           write both
//   node scripts/gen-ci-main.mjs --check   exit 1 if either committed file is stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, ".forgejo/workflows/ci.yml");
const OUT = join(ROOT, ".forgejo/workflows/ci-main.yml");
const OUT_FAST = join(ROOT, ".forgejo/workflows/ci-fast.yml");
const OUT_IMPACT = join(ROOT, ".forgejo/workflows/ci-impact.yml");
const OUT_RECHECK = join(ROOT, ".forgejo/workflows/ci-recheck.yml");

export const LANE = { "pr-check": "light-main", "ci-test": "ci-main" };
export const FAST_LANE = { "pr-check": "fast-light", "ci-test": "fast-test" };

const MAIN = {
  lane: LANE,
  branches: "[main, 'bisect/**']",
  group: "ci-main-${{ github.ref }}-${{ github.sha }}",
  header: [
    "# The same CI as ci.yml, for pushes to main and bisect branches, on",
    "# runner labels only they use (light-main, ci-main), so the release's green",
    "# candidate never waits behind the pull-request queue.",
  ],
  tail: [
    "",
    "  # A job that stood down (stand-down-if-superseded.sh) ends success with its steps",
    "  # skipped; this posts its context again as a warning, \"skipped: superseded by X\",",
    "  # so no reader takes an untested commit for a tested one. scripts/ci/stood-down-report.mjs.",
    "  stood-down-report:",
    "    runs-on: light-main",
    "    needs: [typecheck, test]",
    "    if: always()",
    "    timeout-minutes: 5",
    "    steps:",
    "      - uses: https://github.com/actions/checkout@v4",
    "        with:",
    "          fetch-depth: 1",
    "      - name: A stood-down job says so on the commit",
    "        env:",
    "          GATE_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    "          set -o pipefail",
    "          node scripts/ci/stood-down-report.mjs 2>&1 | tee /tmp/stood-down.out",
    "      - name: Ship this job's log to the CI log sink (Forgejo has no log API)",
    "        if: always()",
    "        run: |",
    "          [ -s /tmp/stood-down.out ] || echo \"(no output: the job failed before the report step)\" > /tmp/stood-down.out",
    "          curl -s --max-time 25 -X POST \\",
    "            -H \"x-ci-run: ${{ github.run_number }}\" \\",
    "            -H \"x-ci-sha: ${{ github.sha }}\" \\",
    "            -H \"x-ci-workflow: ${{ github.workflow }}\" \\",
    "            -H \"x-ci-job: stood-down-report\" \\",
    "            -H \"x-ci-status: ${{ job.status }}\" \\",
    "            -H \"x-ci-ref: ${{ github.ref_name }}\" \\",
    "            --data-binary @/tmp/stood-down.out \\",
    "            http://workshop:8767/ci-log \\",
    "            && echo \"shipped the report log to sink\" || echo \"(sink POST failed — non-fatal)\"",
  ],
};
export const FAST = {
  lane: FAST_LANE,
  branches: "['fast/**']",
  group: "ci-fast-${{ github.ref }}",
  // A newer push of fast/<pr> (the lane re-merged it onto a newer main) supersedes the older run: only
  // the newest merge of a pull request is worth the reserved runner's one slot (2026-10-15: four runs of
  // one pull request queued there, one after another).
  cancel: true,
  // A run goes on only while its pull request is open and still at the head it merged (fast-lane.mjs live).
  transform: (body) => liveGated(body),
  header: [
    "# The same CI as ci.yml, for a push to fast/<pr>: main plus one critical pull",
    "# request (scripts/ci/fast-lane.mjs), on labels only the reserved fast runner",
    "# carries (fast-light, fast-test), so a critical fix never waits behind the",
    "# queue it may be fixing. The last job writes its verdicts onto the PR's head.",
  ],
  tail: [
    "",
    "  # Each verdict above, written onto the pull request's head as its own check",
    "  # (CI / <job> (pull_request)), so merge-pr and the merge queue read the fast",
    "  # run like any other. scripts/ci/fast-lane.mjs report.",
    "  # On the fast lane's dispatcher, not fast-light: it only reads verdicts and writes checks, and on",
    "  # the fast runner's one slot it waited 28 min behind the NEXT critical run's tests (2026-10-13).",
    "  fast-lane-report:",
    "    runs-on: fast-dispatch",
    "    needs: [live, typecheck, test]",
    "    if: always() && needs.live.outputs.go == 'true'",
    "    timeout-minutes: 10",
    "    steps:",
    "      - uses: https://github.com/actions/checkout@v4",
    "        with:",
    "          fetch-depth: 2",
    "      - name: Write the verdicts onto the pull request",
    "        env:",
    "          GATE_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "        run: |",
    "          set -o pipefail",
    "          node scripts/ci/fast-lane.mjs report 2>&1 | tee /tmp/fast-report.out",
    "      - name: Ship this job's log to the CI log sink (Forgejo has no log API)",
    "        if: always()",
    "        run: |",
    "          [ -s /tmp/fast-report.out ] || echo \"(no report output: the job failed before the report step)\" > /tmp/fast-report.out",
    "          curl -s --max-time 25 -X POST \\",
    "            -H \"x-ci-run: ${{ github.run_number }}\" \\",
    "            -H \"x-ci-sha: ${{ github.sha }}\" \\",
    "            -H \"x-ci-workflow: ${{ github.workflow }}\" \\",
    "            -H \"x-ci-job: fast-lane-report\" \\",
    "            -H \"x-ci-status: ${{ job.status }}\" \\",
    "            -H \"x-ci-ref: ${{ github.ref_name }}\" \\",
    "            --data-binary @/tmp/fast-report.out \\",
    "            http://workshop:8767/ci-log \\",
    "            && echo \"shipped the report log to sink\" || echo \"(sink POST failed — non-fatal)\"",
  ],
};

export const IMPACT_SHARDS = 6;
/** Steps of the test job that speak for a commit or deploy: a shard of the impact run is neither a verdict
 *  on main nor a release, so ci-impact.yml leaves them out. */
export const IMPACT_DROPS = [
  "No test file over its time budget",
  "Tests that passed only on a retry",
  "Test balance (no single file may become the job's wall clock)",
  "Did the affected set miss this? (tracker lane, on red)",
  "Say what this run covered (suite / affected, suite / full)",
  "The impact map's shadow",
  "Report the impact map's shadow",
  "Record the coverage cells the tests claim (main runs)",
  "Find the merge that turned main red (main, on red)",
  "Report this merge's verdict to the red tip that asked (bisect runs)",
  "Deploy if the images are pushed (else the image side deploys)",
];

/** PURE. The `name` job's lines out of a workflow's jobs block (from its `  name:` line to the next job). */
export function jobLines(body, name) {
  const at = body.findIndex((l) => l === `  ${name}:`);
  if (at < 0) throw new Error(`ci.yml has no ${name} job`);
  let end = body.findIndex((l, i) => i > at && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l));
  if (end < 0) end = body.length;
  return body.slice(at, end);
}

/** PURE. `job` without the steps named in `names`: each from its `- name:` line to the next step or comment. */
export function dropSteps(job, names) {
  const out = [];
  const found = new Set();
  for (let i = 0; i < job.length; i++) {
    const m = /^ {6}- name: (.*)$/.exec(job[i]);
    if (m && names.includes(m[1].trim())) {
      found.add(m[1].trim());
      while (i + 1 < job.length && !/^ {6}(- |#)/.test(job[i + 1]) && !/^ {0,5}\S/.test(job[i + 1])) i++;
      continue;
    }
    out.push(job[i]);
  }
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) throw new Error(`ci.yml's test job has no step named ${missing.map((n) => `"${n}"`).join(", ")} (IMPACT_DROPS in gen-ci-main.mjs)`);
  return out;
}

// THE TEST IMPACT MAP (#5761 A1, scripts/test-impact.mjs): ci.yml's test job, recording which source lines
// each api test runs. One file at a time against the job's one api, so no two files share its counts; six
// jobs, each a shard of the suite, so the night's run is a quarter hour a shard on the test runners, each a
// CI stack of its own. A first cut ran four apis in one job and broke 14 files (a job one api made, taken by
// another's worker); its fix, a database each, broke 59 (what the CI image bakes into the one database).
// A stack per job is the one that matches CI. The last job builds the map from every shard's part.
export const IMPACT = {
  lane: { "pr-check": "pr-check", "ci-test": "ci-test" },
  on: ["  workflow_dispatch:", "  schedule:", "    # Nightly, clear of the 09:41 heartbeat and the 08:00 bake.", "    # SINGLE SLOT OK: a lost night leaves yesterday's map, and selection judges a change against", "    # the map's own commit, so an older map is still a correct one.", "    - cron: '23 6 * * *'"],
  group: "ci-impact-${{ github.run_id }}",
  header: [
    "# ci.yml's test job, recording which source lines each api test runs (the test",
    "# impact map, scripts/test-impact.mjs): one file at a time, a shard per job, and",
    "# the last job builds the map from the parts.",
  ],
  transform(body) {
    let job = jobLines(body, "test");
    job = dropSteps(job, IMPACT_DROPS);
    const ri = job.findIndex((l) => l === "    runs-on: ci-test");
    job.splice(ri + 1, 0, "    strategy:", "      fail-fast: false", "      matrix:", `        shard: [${Array.from({ length: IMPACT_SHARDS }, (_, i) => i + 1).join(", ")}]`);
    const set = (from, to) => {
      const i = job.findIndex((l) => l === from);
      if (i < 0) throw new Error(`ci.yml's test job has no line "${from.trim()}"`);
      job[i] = to;
    };
    set('      ATTRIBUTION: ""', '      ATTRIBUTION: "1"');
    set('      IMPACT_SHARD: ""', `      IMPACT_SHARD: \${{ matrix.shard }}/${IMPACT_SHARDS}`);
    return ["jobs:", ...trimEnd(job)];
  },
  tail: [
    "",
    "  # Every shard's part, as one map, to the sink (POST /impact). Only when all are in: a map missing a",
    "  # shard would never select that shard's tests. scripts/test-impact.mjs assemble.",
    "  impact-map:",
    "    runs-on: pr-check",
    "    needs: [test]",
    "    if: always()",
    "    timeout-minutes: 10",
    "    steps:",
    "      - uses: https://github.com/actions/checkout@v4",
    "        with:",
    "          fetch-depth: 1",
    "      - name: Install deps (the map parses TypeScript)",
    "        run: |",
    "          STORE_FLAG=\"\"; [ -d /pnpm-store ] && STORE_FLAG=\"--store-dir /pnpm-store\"",
    "          corepack enable",
    "          pnpm install --frozen-lockfile $STORE_FLAG",
    "      - name: Build the map from the shards' parts",
    "        run: |",
    "          set -o pipefail",
    `          node scripts/test-impact.mjs assemble --run "$GITHUB_RUN_ID" --shards ${IMPACT_SHARDS} --commit "$GITHUB_SHA" 2>&1 | tee /tmp/impact-map.out`,
    "      - name: Ship this job's log to the CI log sink (Forgejo has no log API)",
    "        if: always()",
    "        run: |",
    "          [ -s /tmp/impact-map.out ] || echo \"(no output: the job failed before the map step)\" > /tmp/impact-map.out",
    "          curl -s --max-time 25 -X POST \\",
    "            -H \"x-ci-run: ${{ github.run_number }}\" \\",
    "            -H \"x-ci-sha: ${{ github.sha }}\" \\",
    "            -H \"x-ci-workflow: ${{ github.workflow }}\" \\",
    "            -H \"x-ci-job: impact-map\" \\",
    "            -H \"x-ci-status: ${{ job.status }}\" \\",
    "            -H \"x-ci-ref: ${{ github.ref_name }}\" \\",
    "            --data-binary @/tmp/impact-map.out \\",
    "            http://workshop:8767/ci-log \\",
    "            && echo \"shipped the map log to sink\" || echo \"(sink POST failed — non-fatal)\"",
  ],
};

// THE DIRECT POLICY'S RECHECK (lib/direct-merge.mjs): a pull request whose files main changed since its
// green run gets one run on main plus its head, pushed to recheck/<pr>-<head>. It ran on main's lane until
// 2026-10-11, when three rechecks held both of main's runners and main's own typechecks waited half an
// hour behind them: a recheck is a pull request's run, so it takes the pull request lane's labels.
export const RECHECK = {
  lane: { "pr-check": "pr-check", "ci-test": "ci-test" },
  branches: "['recheck/**']",
  group: "ci-recheck-${{ github.ref }}-${{ github.sha }}",
  header: [
    "# The same CI as ci.yml, for a push to recheck/<pr>-<head>: the direct policy's",
    "# one run of a pull request on current main (scripts/lib/direct-merge.mjs). On",
    "# the pull request lane's own labels: a recheck is a pull request's run, and on",
    "# main's lane it held main's own typechecks behind it.",
  ],
  tail: [],
};

/**
 * The fast lane's jobs wait on a `live` job, on the dispatcher's small slot, that asks whether the pull
 * request is still open and still at the head this run merged (scripts/ci/fast-lane.mjs live). A run
 * queued before its pull request closed or moved on then stands down in seconds instead of holding the
 * reserved runner (2026-10-15: #6587, closed, held it for over an hour while the owner asked why the
 * fast lane was not running).
 */
function liveGated(body) {
  const out = [];
  let inJob = null;
  for (const line of trimEnd(body)) {
    const job = /^  ([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (job) inJob = job[1];
    if (line === "jobs:") {
      out.push(line, ...LIVE_JOB);
      continue;
    }
    // Every job of ci.yml waits on the live job and runs only when it says go. ci.yml's own `if:`
    // (a pull request's ci:ready gate) never applies to a push to fast/<pr>, so it is replaced.
    if (inJob && /^    runs-on: /.test(line)) {
      out.push(line, "    needs: [live]");
      continue;
    }
    out.push(line);
  }
  return dropReadyGate(out);
}
const LIVE_JOB = [
  "  # Is this run still worth the reserved runner? Only while its pull request is open and at this head.",
  "  live:",
  "    runs-on: fast-dispatch",
  "    timeout-minutes: 5",
  "    outputs:",
  "      go: ${{ steps.live.outputs.go }}",
  "    steps:",
  "      - uses: https://github.com/actions/checkout@v4",
  "        with:",
  "          fetch-depth: 2",
  "      - id: live",
  "        env:",
  "          GATE_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
  "        run: node scripts/ci/fast-lane.mjs live",
  "",
];
/** ci.yml's `if: >-` ready gate, three lines, becomes the live job's answer. */
function dropReadyGate(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "    if: >-" && /github\.event_name != 'pull_request' \|\|/.test(lines[i + 1] ?? "")) {
      out.push("    if: needs.live.outputs.go == 'true'");
      i += 3;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

/** ci-main.yml's (or, with FAST, ci-fast.yml's) text, from ci.yml's. Throws when ci.yml no longer has the shape this relies on. */
export function generate(ci, kind = MAIN) {
  const LANE = kind.lane;
  const lines = ci.split("\n");
  const at = (re, from = 0) => {
    const i = lines.findIndex((l, n) => n >= from && re.test(l));
    if (i < 0) throw new Error(`ci.yml has no line matching ${re}`);
    return i;
  };
  const on = at(/^on:\s*$/);
  const conc = at(/^concurrency:\s*$/, on);
  const jobs = at(/^jobs:\s*$/, conc);
  const pr = at(/^ {2}pull_request:\s*$/, on);
  if (pr > conc) throw new Error("ci.yml's pull_request trigger is not inside its on: block");
  if (lines.slice(on, conc).some((l) => /^ {2}push:/.test(l))) throw new Error("ci.yml must not trigger on push: main's pushes run ci-main.yml");
  // ci.yml's pull_request path filter, when it has one (it has none since
  // the docs-only workflow went: the selectors skip what a change cannot reach).
  const paths = [];
  const pi = lines.findIndex((l, n) => n > pr && n < conc && /^ {4}paths-ignore:\s*$/.test(l));
  if (pi >= 0) for (let i = pi + 1; i < conc && /^ {6}- /.test(lines[i]); i++) paths.push(lines[i]);

  const body = lines.slice(jobs).map((l) => {
    const m = /^( {4}runs-on: )(\S+)\s*$/.exec(l);
    if (!m) return l;
    const to = LANE[m[2]];
    if (!to) throw new Error(`ci.yml has a job on '${m[2]}', which has no ${kind === MAIN ? "main" : kind === FAST ? "fast" : kind === IMPACT ? "impact" : "recheck"} lane in gen-ci-main.mjs`);
    return `${m[1]}${to}`;
  });
  for (const [from, to] of Object.entries(LANE)) {
    if (!body.some((l) => l === `    runs-on: ${to}`)) throw new Error(`no ci.yml job ran on '${from}'`);
  }
  const name = lines.find((l) => /^name:/.test(l));
  return [
    "# GENERATED from ci.yml by scripts/gen-ci-main.mjs. Do not edit: change",
    "# ci.yml and run `node scripts/gen-ci-main.mjs` (lint:ci-main-generated).",
    "#",
    ...kind.header,
    "# Why, and what differs: the header of",
    "# scripts/gen-ci-main.mjs.",
    "",
    name,
    "",
    "on:",
    ...(kind.on ?? ["  push:", `    branches: ${kind.branches}`, ...(paths.length ? ["    paths-ignore:", ...paths] : [])]),
    "",
    "concurrency:",
    `  group: ${kind.group}`,
    `  cancel-in-progress: ${kind.cancel ? "true" : "false"}`,
    "",
    ...(kind.transform ? kind.transform(body) : kind.tail.length ? trimEnd(body) : body),
    ...kind.tail,
    ...(kind.tail.length ? [""] : []),
  ].join("\n");
}

function trimEnd(lines) {
  let e = lines.length;
  while (e > 0 && lines[e - 1].trim() === "") e--;
  return lines.slice(0, e);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = readFileSync(SRC, "utf8");
  const outs = [[OUT, generate(ci, MAIN)], [OUT_FAST, generate(ci, FAST)], [OUT_RECHECK, generate(ci, RECHECK)], [OUT_IMPACT, generate(ci, IMPACT)]];
  if (process.argv.includes("--check")) {
    let bad = 0;
    for (const [out, want] of outs) {
      let have = "";
      try {
        have = readFileSync(out, "utf8");
      } catch {}
      if (have !== want) {
        console.error(`lint:ci-main-generated - ${out.slice(ROOT.length + 1)} is not what ci.yml generates. Run: node scripts/gen-ci-main.mjs`);
        bad = 1;
      }
    }
    if (bad) process.exit(1);
    console.log("lint:ci-main-generated OK (ci-main.yml, ci-fast.yml, ci-recheck.yml and ci-impact.yml are ci.yml on their lanes)");
  } else {
    for (const [out, want] of outs) {
      writeFileSync(out, want);
      console.log(`wrote ${out.slice(ROOT.length + 1)}`);
    }
  }
}
