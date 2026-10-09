#!/usr/bin/env tsx
// A workflow must ask for a runner label that exists.
//
// THE BUG THIS EXISTS FOR (2026-08-16): coupling-census.yml shipped with
// `runs-on: self-hosted`, a label no runner on this instance carries. Forgejo
// accepted the file, showed a small warning next to it in the UI, and the
// workflow simply never ran. Nothing failed, because a job that is never
// scheduled cannot fail — the census would have quietly produced no readings
// until somebody noticed the absence, which is the worst shape of bug: silence
// where you expected data.
//
// The label was written from memory instead of copied from a working workflow.
// That is not a mistake care prevents; it is one an allowlist prevents.
//
//   npx tsx scripts/lint-ci-runner-labels.ts   (pnpm run lint ci-runner-labels)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".forgejo", "workflows");

/** Labels runners on this instance actually carry.
 *
 *  `ubuntu-latest` is the hosted-style default the images answer to; `light`
 *  is the small A6 runner used for typecheck/lint work; `ci-test` is the one
 *  pinned for the postgres-backed suite. Adding a label here without adding a
 *  runner that answers to it re-creates exactly the silence above, so treat
 *  this list as a claim about infrastructure, not a formality. */
// bake-<box> is one label per PHYSICAL machine: the pool image is baked and
// committed locally, so the nightly bake has to land on each box by name.
// docker-build is the image build's own runner: its queued runs stand down in
// seconds there instead of waiting behind typecheck for a runner per job.
// light-main and ci-main are main's own lane (ci-main.yml, generated from
// ci.yml by scripts/gen-ci-main.mjs): runners that carry ONLY those labels, on
// two boxes, so main's pushes never wait behind the pull-request queue.
// release is the nightly publish's own runner (the A6's cobblr-a6-3, label `release`
// only): on 2026-10-06 the publish waited over four hours behind ~60 per-merge runs for
// an ubuntu-latest slot and try and app missed the nightly. Only RELEASE_LANE_WORKFLOWS
// may ask for it, and every job in them must, or that job queues behind pull requests
// again (checked below).
// (This list is a copy of RELEASE_LANE_WORKFLOWS in scripts/lib/release-lane.mjs, which the
// public export does not ship; a test keeps the two equal.)
const RELEASE_LANE_WORKFLOWS = ["publish-selfhost-images.yml", "release-stable.yml"];
// One label a line: two pull requests that each add or drop a label then merge cleanly.
const KNOWN = new Set([
  "image-main",
  "image-pr",
  "release",
  "ubuntu-latest",
  "light",
  "ci-test",
  "ci-test-full",
  "ci-e2e",
  "bake-a6",
  "bake-aurora",
  "docker-build",
  "light-main",
  "ci-main",
  "fast-light",
  "fast-test",
  "fast-dispatch",
  "pr-check",
]);

// THE b550 IS TEST-ONLY (2026-10-07, server-setup #190: a bad DRAM spot). A job there may compute, but nothing
// it makes may leave the box: no artifact upload, no image push, no release asset, no publish script, since a
// flipped bit would ship. nightly-tour's `record` job made the homepage's published media on `ci-test`, a
// label the b550 carries. A deliberate exception says why on the runs-on line: `# b550-ok: <why>`.
const B550_LABELS = new Set(["ci-test", "bake-b550"]);
// One list of what publishes, for both rules below (a test-only box and a pr-check job never ship anything).
const PUBLISHES = /actions\/upload-artifact|\bdocker push\b|buildx build[^\n]*--push|--push\b|\/releases\/[^\s]*assets|publish-[\w-]+\.(?:py|sh|mjs)\b|\bgh release\b|\bgit push\b|\b(?:npm|pnpm) publish\b|\bcrane push\b|\bskopeo copy\b|\boras push\b/;
/** The job body that starts at `runs-on` line i: up to the next job header (two-space indent). */
function jobBody(lines: string[], i: number): string {
  const out: string[] = [];
  for (let j = i; j < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[j]!); j++) if (!/^\s*#/.test(lines[j]!)) out.push(lines[j]!);
  return out.join("\n");
}

const errors: string[] = [];
const seen = new Map<string, string[]>();

for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const src = readFileSync(join(DIR, f), "utf8");
  src.split("\n").forEach((line, i) => {
    const m = /^\s*runs-on:\s*(.+?)\s*$/.exec(line);
    if (!m) return;
    const label = m[1]!.replace(/^["']|["']$/g, "");
    // `runs-on: ${{ matrix.box }}` USED to be waved through as "an expression,
    // not ours to judge" — but a matrix is where the typo hides best: the job
    // is never scheduled and nothing fails, which is the exact silence this
    // lint exists for. Expand it: find that matrix key's values in the file and
    // judge each one.
    const mx = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(label);
    if (mx) {
      const key = mx[1]!;
      const vals = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(src);
      if (!vals) {
        errors.push(
          `.forgejo/workflows/${f}:${i + 1} runs-on is \`${label}\` but no \`${key}: [ … ]\` matrix was found in the file — ` +
            `a job whose label never resolves is never scheduled, and never fails.`,
        );
        return;
      }
      for (const raw of vals[1]!.split(",")) {
        const v = raw.trim().replace(/^["']|["']$/g, "");
        if (!v) continue;
        seen.set(v, [...(seen.get(v) ?? []), `${f}:${i + 1}`]);
        if (!KNOWN.has(v)) {
          errors.push(
            `.forgejo/workflows/${f}:${i + 1} matrix ${key} includes runner label "${v}", which no runner carries. ` +
              `That leg is never scheduled, so it fails SILENTLY — known labels: ${[...KNOWN].join(", ")}`,
          );
        }
      }
      return;
    }
    if (label.startsWith("$")) return; // some other expression; not ours to judge
    seen.set(label, [...(seen.get(label) ?? []), `${f}:${i + 1}`]);
    if (B550_LABELS.has(label) && !/# b550-ok: \S/.test(line)) {
      const what = PUBLISHES.exec(jobBody(src.split("\n"), i))?.[0];
      if (what) errors.push(`.forgejo/workflows/${f}:${i + 1} runs on "${label}", which the test-only b550 carries (bad RAM), and the job publishes (${what}): a flipped bit would ship. Run it on an A6-only label (ci-e2e for the test image), or say why on the line: # b550-ok: <why>.`);
    }
    const inLane = RELEASE_LANE_WORKFLOWS.includes(f);
    if (label === "release" && !inLane) {
      errors.push(`.forgejo/workflows/${f}:${i + 1} asks for runner label "release", which is the release lane's alone: only ${RELEASE_LANE_WORKFLOWS.join(", ")} may (the runner takes one job at a time, so anything else queues a release behind it).`);
    }
    if (inLane && label !== "release") {
      errors.push(`.forgejo/workflows/${f}:${i + 1} is a release-lane workflow but this job asks for "${label}": it would queue behind every pull request again, the way the nightly publish waited four hours on 2026-10-06. Use \`runs-on: release\`.`);
    }
    if (!KNOWN.has(label)) {
      errors.push(
        `.forgejo/workflows/${f}:${i + 1} asks for runner label "${label}", which no runner carries. ` +
          `A job with an unmatched label is never scheduled, so it fails SILENTLY — ` +
          `known labels: ${[...KNOWN].join(", ")}`,
      );
    }
  });
}

if (seen.size === 0) {
  console.error("[lint:ci-runner-labels] ✗ found no runs-on at all — did the workflow dir move?");
  process.exit(1);
}

// MAIN'S LANE IS NEVER A PULL REQUEST'S (2026-10-09). Forgejo hands out the oldest waiting job a runner's
// labels match, so a train batch's typecheck waited 31 minutes behind PR runs on the runners that shared
// light-main with pr-check. The fleet now keeps a runner that carries light-main and no PR label
// (server-setup forge-ci/fleet-policy.json `main_lane`, whose never_labels are PR_LANE_LABELS below). Two
// things here keep that true from this side: a pull-request workflow never asks for a main-lane label
// (it would queue on main's own runner), and every label a pull-request workflow asks for is in
// PR_LANE_LABELS (a new one must be added there AND to the policy's pr_labels, or main's runner may
// carry it and serve pull requests again).
const MAIN_LANE_LABELS = new Set(["light-main", "ci-main"]);
// A copy of main_lane.pr_labels in server-setup forge-ci/fleet-policy.json: change both together.
const PR_LANE_LABELS = new Set(["ci-test", "pr-check", "image-pr", "fast-dispatch", "fast-light", "fast-test"]);
/** The events a workflow runs on: `on: x`, `on: [x, y]`, or the keys of an `on:` block. */
function triggers(src: string): string[] {
  const lines = src.split("\n");
  const i = lines.findIndex((l) => /^"?on"?:/.test(l));
  if (i < 0) return [];
  const inline = /^"?on"?:\s*(.+?)\s*$/.exec(lines[i]!)?.[1];
  if (inline) return inline.replace(/[[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  for (let j = i + 1; j < lines.length && !/^\S/.test(lines[j]!); j++) {
    const k = /^ {2}([a-z_]+):/.exec(lines[j]!)?.[1];
    if (k) out.push(k);
  }
  return out;
}
/** Every runner label a workflow asks for, matrix legs expanded. */
function labelsOf(src: string): { label: string; line: number }[] {
  const out: { label: string; line: number }[] = [];
  src.split("\n").forEach((l, i) => {
    const m = /^\s*runs-on:\s*(.+?)\s*(?:#.*)?$/.exec(l);
    if (!m) return;
    const label = m[1]!.replace(/^["']|["']$/g, "");
    const mx = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(label);
    if (mx) {
      const vals = new RegExp(`^\\s*${mx[1]}:\\s*\\[([^\\]]*)\\]`, "m").exec(src)?.[1] ?? "";
      for (const v of vals.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) out.push({ label: v, line: i + 1 });
    } else if (!label.startsWith("$")) out.push({ label, line: i + 1 });
  });
  return out;
}
function mainLaneErrors(file: string, src: string): string[] {
  const errs: string[] = [];
  const on = triggers(src);
  if (!on.some((t) => t.startsWith("pull_request") || t === "issue_comment")) return errs;
  for (const { label, line } of labelsOf(src)) {
    if (MAIN_LANE_LABELS.has(label)) {
      errs.push(`.forgejo/workflows/${file}:${line} runs on pull requests (${on.join(", ")}) but asks for "${label}", main's own lane: a pull request would take main's runner and a train batch would queue behind it. Use pr-check or ci-test.`);
    } else if (!PR_LANE_LABELS.has(label)) {
      errs.push(`.forgejo/workflows/${file}:${line} runs on pull requests (${on.join(", ")}) and asks for "${label}", which is not a pull-request label (PR_LANE_LABELS). If it is one now, add it there AND to main_lane.pr_labels in server-setup forge-ci/fleet-policy.json, so main's runner never carries it.`);
    }
  }
  return errs;
}
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  errors.push(...mainLaneErrors(f, readFileSync(join(DIR, f), "utf8")));
}

// pr-check RUNS ON THE TEST-ONLY BOXES (b550 and z87 until memtest passes, the lent XPS: owner,
// 2026-10-07), so a job asking for it must never publish, push or ship anything: a flipped bit there
// may turn a check red, never reach something shared. A step that does must be guarded to a push to
// main (which runs on main's own lane, never on pr-check).
for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
  const src = readFileSync(join(DIR, f), "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^ {2}[\w-]+:\s*$/.test(lines[i] ?? "")) continue;
    let end = i + 1;
    while (end < lines.length && !/^ {2}[\w-]+:\s*$/.test(lines[end] ?? "") && !/^\S/.test(lines[end] ?? "")) end++;
    const job = lines.slice(i, end);
    if (!job.some((l) => /^ {4}runs-on:\s*pr-check\s*$/.test(l))) continue;
    let s0: number;
    const steps: number[] = [];
    job.forEach((l, k) => { if (/^ {6}- (name|uses|run):/.test(l)) steps.push(k); });
    steps.push(job.length);
    for (let k = 0; k + 1 < steps.length; k++) {
      const step = job.slice(steps[k], steps[k + 1]).join("\n");
      s0 = i + (steps[k] ?? 0);
      if (!PUBLISHES.test(step)) continue;
      if (/^ {8}if:.*(refs\/heads\/main|event_name == 'push')/m.test(step)) continue;
      errors.push(`.forgejo/workflows/${f}:${s0 + 1} a pr-check job's step publishes or pushes (${PUBLISHES.exec(step)![0]}) without a guard to main's pushes: pr-check runs on the test-only boxes, which must never ship anything. Guard it with \`if: github.event_name == 'push' && github.ref == 'refs/heads/main'\`, or move it to a job on light.`);
    }
  }
}

if (errors.length === 0) {
  console.log(`[lint:ci-runner-labels] ✓ ${seen.size} distinct runner label(s), all real`);
  process.exit(0);
}
console.error(`\n[lint:ci-runner-labels] ✗ ${errors.length} unmatched runner label(s):\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error(
  `\nCopy the label from a workflow that already runs rather than writing one from\n` +
    `memory. If a genuinely new runner exists, add its label to KNOWN in this lint —\n` +
    `and only once a runner answers to it.\n`,
);
process.exit(1);
