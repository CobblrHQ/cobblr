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
// A MERGE TRAIN RIDES THIS LANE TOO. A train branch (train/<id>) is main to
// be: its members merged onto main, landed fast-forward when green. Its CI
// is a push to `train/**` here, on main's runners, so a train never queues
// behind the pull requests it is about to replace; and the train's pull
// request is not marked ready, so ci.yml's copy skips (commit-ci-state.py
// lets a push run of the same job answer for a skipped one).
//
// What differs from ci.yml, and nothing else:
//   - on: push to main, train/** and bisect/** (one untested merge under a red
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

export const LANE = { "pr-check": "light-main", "ci-test": "ci-main" };
export const FAST_LANE = { "pr-check": "fast-light", "ci-test": "fast-test" };

const MAIN = {
  lane: LANE,
  branches: "[main, 'train/**', 'bisect/**']",
  group: "ci-main-${{ github.ref }}-${{ github.sha }}",
  header: [
    "# The same CI as ci.yml, for pushes to main and merge-train branches, on",
    "# runner labels only they use (light-main, ci-main), so the release's green",
    "# candidate and the next train never wait behind the pull-request queue.",
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
    "  fast-lane-report:",
    "    runs-on: fast-light",
    "    needs: [typecheck, test]",
    "    if: always()",
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
    if (!to) throw new Error(`ci.yml has a job on '${m[2]}', which has no ${kind === MAIN ? "main" : "fast"} lane in gen-ci-main.mjs`);
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
    "  push:",
    `    branches: ${kind.branches}`,
    ...(paths.length ? ["    paths-ignore:", ...paths] : []),
    "",
    "concurrency:",
    `  group: ${kind.group}`,
    "  cancel-in-progress: false",
    "",
    ...(kind.tail.length ? trimEnd(body) : body),
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
  const outs = [[OUT, generate(ci, MAIN)], [OUT_FAST, generate(ci, FAST)]];
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
    console.log("lint:ci-main-generated OK (ci-main.yml and ci-fast.yml are ci.yml on their lanes)");
  } else {
    for (const [out, want] of outs) {
      writeFileSync(out, want);
      console.log(`wrote ${out.slice(ROOT.length + 1)}`);
    }
  }
}
