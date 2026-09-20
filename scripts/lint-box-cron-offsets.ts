#!/usr/bin/env tsx
// No two box schedules that can tear or race each other share a start
// minute: the installer's cron entries stand off each other and off the
// box's standing schedules.
//
// THE BUG THIS PREVENTS. Twice. 2026-09-19: the rig refresh (05:30) pulled
// four images in the same second the health tick (*/5) started a container,
// and the pull failed on a containerd lease that was already gone (#3197).
// 2026-09-20: the checkout sync (*/10) replaced the tick's own file in the
// same second the tick (*/5) started, so one tick ran the OLD tick calling
// the NEW helper it had just installed: a torn process, half of each version,
// and one extra alert transition in the channel that nothing in either file
// afterwards could explain (#3224 follow-up). Both fixes were a single offset
// on a single pair; this is the rule they share, where the cron lines are
// written, so the next schedule somebody adds cannot land on the grid.
//
// THE RULE. Every cron entry the installer writes
// (scripts/dev-rig/install-core-checkout.sh, the /etc/cron.d heredoc) is
// simulated over a week, and no two of them, and none of them with a
// standing schedule on the box (scripts/dev-rig/box-standing-schedules:
// root's crontab entries this repo does not write; the tick's
// box-cron-drift.sh raises 🔴 when that list and the real crontab differ,
// so it is kept honest by the box, not by hand), may fire in the same minute.
// A genuine exception is a line ending `# same-minute-ok: <why>`, which
// says the two touch nothing of each other's.
//
// PROVEN RED 2026-09-20 against the installer's `*/10` sync line, which
// shares every tenth minute with the tick's `*/5`.
//
//   npx tsx scripts/lint-box-cron-offsets.ts   (pnpm run lint:box-cron-offsets)
import { readFileSync } from "node:fs";

const INSTALLER = "scripts/dev-rig/install-core-checkout.sh";
/** Schedules on the box that this repo does not write: ONE list, in
 *  scripts/dev-rig/box-standing-schedules, which the box's tick compares
 *  with root's actual crontab (box-cron-drift.sh) so a cron added by hand
 *  tells this lint its picture is stale instead of the lint assuming. */
const STANDING_FILE = "scripts/dev-rig/box-standing-schedules";
const BOX_STANDING: Array<{ spec: string; what: string }> = readFileSync(STANDING_FILE, "utf8").split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => { const f = l.trim().split(/\s+/); return { spec: f.slice(0, 5).join(" "), what: f.slice(5).join(" ") }; });

interface Entry { spec: string; what: string; line: number; ok?: string }
interface Violation { file: string; line: number; what: string }

function field(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron field I cannot read: ${part}`);
    let lo = min, hi = max;
    if (m[1] !== "*") { const r = m[1]!.split("-").map(Number); lo = r[0]!; hi = r[1] ?? (m[2] ? max : r[0]!); }
    const step = m[2] ? Number(m[2]) : 1;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
/** Every minute of a week (0..10079) the spec fires on. */
function firings(spec: string): Set<number> {
  const [mi, ho, dom, mon, dow] = spec.trim().split(/\s+/);
  if (!mi || !ho || !dom || !mon || !dow) throw new Error(`not five fields: ${spec}`);
  const mins = field(mi, 0, 59), hours = field(ho, 0, 23), dows = field(dow, 0, 6);
  const doms = field(dom, 1, 31);
  const out = new Set<number>();
  for (let d = 0; d < 7; d++) {
    if (!dows.has(d) && dow !== "*") continue;
    if (dom !== "*" && !doms.has(d + 1)) continue; // a week starting on the 1st; enough for a same-minute check
    for (const h of hours) for (const m of mins) out.add(d * 1440 + h * 60 + m);
  }
  return out;
}

const src = readFileSync(INSTALLER, "utf8").split("\n");
const entries: Entry[] = [];
src.forEach((l, i) => {
  const m = l.match(/^((?:[\d*,\/-]+\s+){5})root\s+(\S+)(.*)$/);
  if (!m) return;
  const ok = m[3]?.match(/# same-minute-ok: (.+)$/)?.[1];
  entries.push({ spec: m[1]!.trim(), what: m[2]!, line: i + 1, ...(ok ? { ok } : {}) });
});

const violations: Violation[] = [];
if (entries.length === 0) violations.push({ file: INSTALLER, line: 1, what: "no cron entries found; the heredoc moved and this lint reads nothing" });
const all = [...entries.map((e) => ({ ...e, standing: false })), ...BOX_STANDING.map((s) => ({ ...s, line: 0, ok: undefined, standing: true }))];
for (let a = 0; a < entries.length; a++) {
  const ea = entries[a]!;
  if (ea.ok) continue;
  const fa = firings(ea.spec);
  for (let b = a + 1; b < all.length; b++) {   // each pair once; standing schedules sit after the entries
    const eb = all[b]!;
    if (eb.ok) continue;
    const shared = [...firings(eb.spec)].filter((x) => fa.has(x));
    if (shared.length) {
      const when = `${String(Math.floor((shared[0]! % 1440) / 60)).padStart(2, "0")}:${String(shared[0]! % 60).padStart(2, "0")}`;
      violations.push({ file: INSTALLER, line: ea.line, what: `\`${ea.spec} ${ea.what}\` and \`${eb.spec} ${eb.what}\`${eb.standing ? " (standing on the box)" : ""} fire in the same minute (${shared.length}x/week, first ${when})` });
    }
  }
}

if (BOX_STANDING.length === 0) violations.push({ file: STANDING_FILE, line: 1, what: "no standing schedules listed; the lint would reason from an empty picture of the box" });

if (violations.length) {
  console.error(`lint:box-cron-offsets - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Two box schedules that can tear or race each other must not share a start minute: pick an offset (3-59/10, 32 5) or say `# same-minute-ok: <why>` when they touch nothing of each other's.");
  process.exit(1);
}
console.log(`lint:box-cron-offsets OK: ${entries.length} installer entries stand off each other and ${BOX_STANDING.length} standing schedules`);
