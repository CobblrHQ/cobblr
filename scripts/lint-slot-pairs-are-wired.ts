#!/usr/bin/env tsx
// A scheduled workflow has two slots or says why one is enough, and only a
// schedule-only workflow may use the standdown.
//
// THE BUG THIS PREVENTS. Forgejo recreates this repository's schedule rows on
// every push to the default branch and computes each `next` from that moment,
// so a merge landing inside a slot's minute takes that slot for the whole day
// and nothing says so: no failed run, no red, just a row that never fired.
// Measured over a fortnight (2026-09-22, #3385): the bench's 06:00 and the
// E2E nightly's 07:00 each lost a day, on exactly the days a merge landed in
// their minute, and 2026-09-13 took 06:00, 06:30, 07:00 AND 07:20 in one
// morning. A single-slot cron on a repo merging thirty PRs a day is a coin
// flip, and the workflows it hurts quietest are the ones whose job is to
// notice things.
//
// THE RULE, three parts:
//
//   1. A workflow with a `schedule:` has TWO crons, or one cron and a
//      `# SINGLE SLOT OK: <reason>` line saying why one is enough.
//   2. A SCHEDULE-ONLY workflow with two crons runs scripts/ci-slot.sh as a
//      `slot` job naming its own file, and every other job needs it. Without
//      that, a morning where both slots fire does the work twice.
//   4. (2026-10-27) A workflow that runs scripts/ci-slot.sh takes an `as_scheduled` dispatch input, and whatever
//      only its scheduled run does tests that input too: a cron run of an older commit than main's is dispatched
//      on main with as_scheduled=true in its place (the forge's schedules can freeze at one commit; lib/ci-slot.mjs).
//   5. (2026-10-28) A workflow that runs scripts/ci-slot.sh and has a run-level `concurrency:` puts a dispatch in
//      its own group (`github.event_name` in the group). The run ci-slot.sh dispatches in a stood-down cron run's
//      place is a dispatch, and Forgejo leaves a job's `if:` to the runner that picks it up: the stood-down run
//      holds a shared group until its gated runner reaches a no-op job. e2e-suite's night run (68003) waited
//      behind its own stood-down cron (68002) from 06:16Z on 10-28, its slot's turn passing every four minutes.
//   6. (2026-11-01) In a workflow that runs scripts/ci-slot.sh, the slot job runs on `light`, and a job on any other
//      label carries no `if:` of its own: it needs a `light` job whose `if:` reads the slot's verdict. Forgejo leaves
//      a job's `if:` to the runner that takes it, so a stood-down run's ci-e2e job waited for that runner only to be
//      skipped (run 60465: from 06:21Z to 02:33Z the next day), counted as waiting demand all along. A job with no
//      `if:` behind a skipped one is skipped by the forge itself, with no runner (#8961).
//   3. A workflow that ALSO runs on push must NOT call scripts/ci-slot.sh.
//      This is the part that matters most and the one a copy gets wrong: the
//      decision tells a cron run from a dispatch, and on this Forgejo a cron
//      run is stored as `event = push`, so on a push-triggered workflow the
//      standdown would see the morning's merges and skip the very run it
//      exists to protect (see the WHY in scripts/lib/ci-slot.mjs).
//
// A workflow may carry its OWN standdown instead of the shared one (bench
// nightly checks the results repo for the day's verdict, which is a better
// answer than the generic one): `# OWN STANDDOWN: <what it checks>` says so.
//
// PROVE IT RED: on the tree at ed2cf264c it names eight single-slot workflows.
//
//   npx tsx scripts/lint-slot-pairs-are-wired.ts   (pnpm run lint:slot-pairs-are-wired)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const DIR = join(ROOT, ".forgejo", "workflows");
const SHARED = "scripts/ci-slot.sh";

interface Violation {
  file: string;
  what: string;
}

/** The `on:` block, where the triggers are; jobs may mention anything. */
export function triggersOf(src: string): string {
  const from = src.search(/^on:/m);
  if (from < 0) return "";
  const rest = src.slice(from);
  const to = rest.search(/^(jobs|concurrency|env|permissions|defaults):/m);
  return to < 0 ? rest : rest.slice(0, to);
}

export interface Shape {
  crons: number;
  onPush: boolean;
  callsShared: boolean;
  singleSlotOk: boolean;
  ownStanddown: boolean;
  runsSlot: boolean;
  asScheduled: boolean;
  scheduleOnly: string[];
  sharedGroup: string | null;
}

/** The run-level concurrency group, when it is one group for a cron run and a dispatch alike (null otherwise). */
export function sharedGroupOf(src: string): string | null {
  const at = src.search(/^concurrency:/m);
  if (at < 0) return null;
  const line = src.slice(at).split("\n").slice(0, 4).find((l) => /^\s+group:/.test(l)) ?? src.slice(at).split("\n")[0] ?? "";
  return /event_name/.test(line) ? null : line.trim();
}
export function shapeOf(src: string): Shape {
  const on = triggersOf(src);
  return {
    crons: (on.match(/^\s*-\s*cron:/gm) ?? []).length,
    onPush: /^ {2}push:/m.test(on),
    callsShared: src.includes(SHARED),
    singleSlotOk: /#\s*SINGLE SLOT OK:\s*\S/.test(src),
    ownStanddown: /#\s*OWN STANDDOWN:\s*\S/.test(src),
    runsSlot: /bash scripts\/ci-slot\.sh /.test(src),
    asScheduled: /^ {6}as_scheduled:/m.test(on),
    sharedGroup: sharedGroupOf(src),
    scheduleOnly: src.split("\n").filter((l) => /github\.event_name == 'schedule'|\$\{\{ github\.event_name \}\}" = "schedule"/.test(l) && !l.includes("as_scheduled") && !l.includes("event_name == 'workflow_dispatch'")).map((l) => l.trim()),
  };
}

export interface Job {
  id: string;
  runsOn: string;
  needs: string[];
  cond: string | null;
}

/** Each job's id, `runs-on`, `needs` and `if:` (one-line forms, which is all these files use). */
export function jobsOf(src: string): Job[] {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs: Job[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]!);
    if (!head) continue;
    const job: Job = { id: head[1]!, runsOn: "", needs: [], cond: null };
    for (let j = i + 1; j < lines.length && !/^ {0,2}\S/.test(lines[j]!); j++) {
      const l = lines[j]!;
      const runsOn = /^ {4}runs-on:\s*(.*)$/.exec(l);
      if (runsOn) job.runsOn = runsOn[1]!.trim();
      const cond = /^ {4}if:\s*(.*)$/.exec(l);
      if (cond) job.cond = cond[1]!.trim();
      const needs = /^ {4}needs:\s*(.*)$/.exec(l);
      if (needs) job.needs = needs[1]!.replace(/[[\]]/g, "").split(",").map((n) => n.trim()).filter(Boolean);
    }
    jobs.push(job);
  }
  return jobs;
}

const LIGHT = "light";

/** Rule 6: what in a slot workflow would wait for a gated runner on a stood-down morning. */
export function standdownWaits(src: string): string[] {
  const jobs = jobsOf(src);
  const out: string[] = [];
  const slot = jobs.find((j) => j.id === "slot");
  if (!slot) return out;
  if (slot.runsOn !== LIGHT) out.push(`the slot job runs on \`${slot.runsOn || "(none)"}\`: every run, stood down or not, waits for that runner just to decide. Run it on \`light\``);
  const gated = new Set(jobs.filter((j) => j.runsOn === LIGHT && j.cond !== null && /needs\.slot\.outputs\.run/.test(j.cond)).map((j) => j.id));
  for (const j of jobs) {
    if (j.id === "slot" || j.runsOn === LIGHT) continue;
    if (j.cond !== null) {
      out.push(`job \`${j.id}\` runs on \`${j.runsOn}\` with an \`if:\` of its own. Forgejo leaves a job's \`if:\` to the runner that takes it, so on a stood-down morning it waits for that runner only to be skipped (#8961). Move the condition to a \`light\` job it needs, and give this one none`);
    } else if (!j.needs.some((n) => gated.has(n))) {
      out.push(`job \`${j.id}\` runs on \`${j.runsOn}\` and needs no \`light\` job whose \`if:\` reads the slot's verdict, so it runs on a stood-down morning too`);
    } else gated.add(j.id);
  }
  return out;
}

const violations: Violation[] = [];
let scheduled = 0;
for (const name of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const src = readFileSync(join(DIR, name), "utf8");
  const s = shapeOf(src);
  if (s.crons === 0) {
    if (s.callsShared) violations.push({ file: name, what: `calls ${SHARED} but has no schedule` });
    continue;
  }
  scheduled++;
  if (s.crons === 1 && !s.singleSlotOk) {
    violations.push({
      file: name,
      what: "one cron and no reason. A merge in that minute takes the day, silently. Add a second slot, or say why one is enough: # SINGLE SLOT OK: <reason>",
    });
  }
  if (s.onPush && s.callsShared) {
    violations.push({
      file: name,
      what: `runs on push AND calls ${SHARED}. A cron run is stored as event=push here, so the standdown would see a merge and skip the run it protects. Move the slot instead, or find a signal that works for a push-triggered workflow`,
    });
  }
  if (s.runsSlot && !s.asScheduled) {
    violations.push({
      file: name,
      what: `runs ${SHARED} but takes no \`as_scheduled\` input. A cron run of an older commit is dispatched on main with as_scheduled=true (lib/ci-slot.mjs); declare it under workflow_dispatch's inputs`,
    });
  }
  for (const line of s.runsSlot ? s.scheduleOnly : []) {
    violations.push({
      file: name,
      what: `\`${line}\` is a scheduled run's alone, and the run ${SHARED} dispatches on main in its place is a dispatch with as_scheduled=true: test that too`,
    });
  }
  if (s.runsSlot && s.sharedGroup) {
    violations.push({
      file: name,
      what: `\`${s.sharedGroup}\` is one concurrency group for a cron run and the dispatch ${SHARED} sends in its place, so a stood-down cron run holds its own replacement until a runner reaches its no-op job. Give a dispatch its own group: group: \${{ github.event_name == 'workflow_dispatch' && format('<name>-dispatch-{0}', github.ref) || '<name>' }}`,
    });
  }
  for (const what of s.runsSlot ? standdownWaits(src) : []) violations.push({ file: name, what });
  if (s.crons > 1 && !s.onPush && !s.callsShared && !s.ownStanddown) {
    violations.push({
      file: name,
      what: `two slots and no standdown: a morning where both fire does the work twice. Add the slot job (${SHARED} ${name}), or say what it checks instead: # OWN STANDDOWN: <what>`,
    });
  }
}

if (violations.length) {
  console.error(`lint:slot-pairs-are-wired - ${violations.length} scheduled workflow(s) that a merge can silently eat:`);
  for (const v of violations) console.error(`  .forgejo/workflows/${v.file}  ${v.what}`);
  console.error(`\nWhy: docs/operations/ci/deploy-and-release.md, "A schedule is lost by a merge in its own minute".`);
  process.exit(1);
}
console.log(`lint:slot-pairs-are-wired OK (${scheduled} scheduled workflow(s))`);
