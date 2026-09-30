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
//   - on: push to main and train/**, with ci.yml's pull_request paths-ignore;
//   - concurrency: one group per commit, never cancelled (every main commit
//     gets its own verdict, as before);
//   - runs-on: light -> light-main, ci-test -> ci-main.
// `name: CI` stays, so the status contexts stay `CI / typecheck (push)` and
// `CI / test (push)`, which the release, merge-pr and deploy read.
//
//   node scripts/gen-ci-main.mjs           write it
//   node scripts/gen-ci-main.mjs --check   exit 1 if the committed file is stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, ".forgejo/workflows/ci.yml");
const OUT = join(ROOT, ".forgejo/workflows/ci-main.yml");

export const LANE = { light: "light-main", "ci-test": "ci-main" };

/** ci-main.yml's text, from ci.yml's. Throws when ci.yml no longer has the shape this relies on. */
export function generate(ci) {
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
  const paths = [];
  for (let i = at(/^ {4}paths-ignore:\s*$/, pr) + 1; i < conc && /^ {6}- /.test(lines[i]); i++) paths.push(lines[i]);
  if (!paths.length) throw new Error("ci.yml's pull_request has no paths-ignore list to copy");

  const body = lines.slice(jobs).map((l) => {
    const m = /^( {4}runs-on: )(\S+)\s*$/.exec(l);
    if (!m) return l;
    const to = LANE[m[2]];
    if (!to) throw new Error(`ci.yml has a job on '${m[2]}', which has no main lane in gen-ci-main.mjs`);
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
    "# The same CI as ci.yml, for pushes to main and merge-train branches, on",
    "# runner labels only they use (light-main, ci-main), so the release's green",
    "# candidate and the next train never wait behind the pull-request queue.",
    "# Why, and what differs: the header of",
    "# scripts/gen-ci-main.mjs.",
    "",
    name,
    "",
    "on:",
    "  push:",
    "    branches: [main, 'train/**']",
    "    paths-ignore:",
    ...paths,
    "",
    "concurrency:",
    "  group: ci-main-${{ github.sha }}",
    "  cancel-in-progress: false",
    "",
    ...body,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = generate(readFileSync(SRC, "utf8"));
  if (process.argv.includes("--check")) {
    let have = "";
    try {
      have = readFileSync(OUT, "utf8");
    } catch {}
    if (have !== want) {
      console.error("lint:ci-main-generated - .forgejo/workflows/ci-main.yml is not what ci.yml generates. Run: node scripts/gen-ci-main.mjs");
      process.exit(1);
    }
    console.log("lint:ci-main-generated OK (ci-main.yml is ci.yml on main's lane)");
  } else {
    writeFileSync(OUT, want);
    console.log("wrote .forgejo/workflows/ci-main.yml");
  }
}
