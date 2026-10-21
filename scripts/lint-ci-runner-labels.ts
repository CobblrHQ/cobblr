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
  // The nightly walk's shards (#7640): cobblr-test-a6-full and cobblr-light-b550, two at a time.
  "ci-walk",
  "bake-a6",
  "docker-build",
  "light-main",
  "ci-main",
  "fast-light",
  "fast-test",
  "fast-dispatch",
  // cobblr-recheck-aurora (server-setup #312): the re-check that holds main frozen, alone.
  "fast-recheck-light",
  "fast-recheck-test",
  "pr-check",
  "android-kvm",
]);

// THE b550 IS TEST-ONLY (2026-10-07, server-setup #190: a bad DRAM spot). A job there may compute, but nothing
// it makes may leave the box: no artifact upload, no image push, no release asset, no publish script, since a
// flipped bit would ship. nightly-tour's `record` job made the homepage's published media on `ci-test`, a
// label the b550 carries. A deliberate exception says why on the runs-on line: `# b550-ok: <why>`.
const B550_LABELS = new Set(["ci-test", "bake-b550", "ci-walk"]);
// One list of what publishes, for both rules below (a test-only box and a pr-check job never ship anything).
const PUBLISHES = /actions\/upload-artifact|\bdocker push\b|buildx build[^\n]*--push|--push\b|\/releases\/[^\s]*assets|publish-[\w-]+\.(?:py|sh|mjs)\b|\bgh release\b|\bgit push\b|\b(?:npm|pnpm) publish\b|\bcrane push\b|\bskopeo copy\b|\boras push\b/;
/** The first line that publishes and does not say why it may (`# b550-ok: <why>` on that line). */
function publishesIn(body: string): string | undefined {
  for (const l of body.split("\n")) {
    const m = PUBLISHES.exec(l);
    if (m && !/# b550-ok: \S/.test(l)) return m[0];
  }
  return undefined;
}
/** A matrix key's values: `key: [a, b]`, or one per `include:` entry, each with the entry's other keys (its leg). */
function matrixValues(src: string, key: string): { value: string; leg: Record<string, string> }[] | null {
  const list = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]`, "m").exec(src);
  if (list) return list[1]!.split(",").map((v) => ({ value: v.trim().replace(/^["']|["']$/g, ""), leg: {} })).filter((v) => v.value);
  const out: { value: string; leg: Record<string, string> }[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const inc = /^(\s*)include:\s*$/.exec(lines[i]!);
    if (!inc) continue;
    let leg: Record<string, string> | null = null;
    const flush = () => leg?.[key] && out.push({ value: leg[key]!, leg });
    for (let j = i + 1; j < lines.length && (lines[j]!.startsWith(`${inc[1]} `) || !lines[j]!.trim()); j++) {
      const kv = /^\s*(-\s+)?([A-Za-z_][\w-]*):\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/.exec(lines[j]!);
      if (!kv) continue;
      if (kv[1]) {
        flush();
        leg = {};
      }
      if (leg) leg[kv[2]!] = kv[3]!;
    }
    flush();
  }
  return out.length ? out : null;
}
/** A job body with the steps a matrix leg never runs taken out: an `if:` that asks for another value of a key
 *  (`matrix.part == 'tours'`, `startsWith(matrix.part, 'walk-')`) and has no `||` to let this leg in. */
function legBody(body: string, leg: Record<string, string>): string {
  const steps = body.split(/\n(?= {6}- )/);
  return steps
    .filter((step) => {
      const cond = /^ {8}if:\s*(.+)$/m.exec(step)?.[1];
      if (!cond || cond.includes("||")) return true;
      for (const m of cond.matchAll(/(!?)matrix\.([A-Za-z_][\w-]*)\s*==\s*'([^']*)'/g)) if (!m[1] && leg[m[2]!] != null && leg[m[2]!] !== m[3]) return false;
      for (const m of cond.matchAll(/(!?)startsWith\(matrix\.([A-Za-z_][\w-]*),\s*'([^']*)'\)/g)) if (!m[1] && leg[m[2]!] != null && !leg[m[2]!]!.startsWith(m[3]!)) return false;
      return true;
    })
    .join("\n");
}
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
      const vals = matrixValues(src, key);
      if (!vals) {
        errors.push(
          `.forgejo/workflows/${f}:${i + 1} runs-on is \`${label}\` but no \`${key}: [ … ]\` matrix was found in the file — ` +
            `a job whose label never resolves is never scheduled, and never fails.`,
        );
        return;
      }
      for (const { value: v, leg } of vals) {
        seen.set(v, [...(seen.get(v) ?? []), `${f}:${i + 1}`]);
        // A leg on a label the b550 carries is judged by the steps that leg runs (#7640: the walk shards share
        // their job with the tours, whose published media stay on ci-e2e).
        if (B550_LABELS.has(v) && !/# b550-ok: \S/.test(line)) {
          const what = publishesIn(legBody(jobBody(src.split("\n"), i), leg));
          if (what) errors.push(`.forgejo/workflows/${f}:${i + 1} matrix leg ${JSON.stringify(leg)} runs on "${v}", which the test-only b550 carries (bad RAM), and a step that leg runs publishes (${what}): a flipped bit would ship. Guard the step to the other legs, or say why on its line: # b550-ok: <why>.`);
        }
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
      const what = publishesIn(jobBody(src.split("\n"), i));
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
const PR_LANE_LABELS = new Set(["ci-test", "pr-check", "image-pr", "fast-dispatch", "fast-light", "fast-test", "fast-recheck-light", "fast-recheck-test"]);
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
      for (const { value } of matrixValues(src, mx[1]!) ?? []) out.push({ label: value, line: i + 1 });
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
