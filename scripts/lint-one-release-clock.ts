/**
 * A nightly gets ONE name, from ONE clock.
 *
 * Its date is an editorial label rather than a physical instant: the release
 * banner prints it, the changelog post calls the nightly by it, the image
 * carries it as a snapshot tag, and the coupling census files its reading under
 * it. Those four have to be the same day or they stop describing the same night.
 *
 * They drifted once and nothing noticed, because each half was internally
 * consistent: the image tag read the day in UTC while the changelog read it
 * locally. An evening cut therefore landed after midnight UTC and took the NEXT
 * day's tag, so the scheduled release the following morning found its own name
 * taken and became `.1` -- a day with a `.1` and no unsuffixed cut, and a
 * previous day wearing re-cuts it never had. Neither side was wrong on its own
 * terms, which is exactly why only a rule spanning both can catch it.
 *
 * So this asserts the two remain the same clock. It is deliberately textual: the
 * one is bash run on the release box and the other is JS run by the publisher,
 * and there is no runtime they share in which a common constant could live.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const failures: string[] = [];

// ── the release script: the day it labels a cut with ────────────────────────
const daily = readFileSync(join(ROOT, "scripts/release-daily.sh"), "utf8");

const snap = daily.match(/^SNAP_DATE=.*$/m)?.[0];
if (!snap) {
  failures.push("scripts/release-daily.sh no longer defines SNAP_DATE. It is the date every dispatch is labelled with; find where that moved and point this lint at it.");
} else if (/date\s+-u/.test(snap)) {
  failures.push(
    `scripts/release-daily.sh reads the nightly's day in UTC:\n      ${snap}\n` +
      "    The changelog names the same nightly by the LOCAL day (scripts/lib/nightly-date.mjs).\n" +
      "    An evening cut then lands after midnight UTC and takes tomorrow's tag, so the next\n" +
      "    morning's scheduled release is forced to a `.1`. Use `date +%F`.",
  );
}

// A date must always be PASSED to the publish workflow. Its own fallback is UTC,
// so a dispatch that omits it silently reopens the split this lint exists to close.
if (!/inputs["']?\s*:\s*\{[^}]*\bdate\b/.test(daily.replace(/\n/g, " "))) {
  failures.push(
    "scripts/release-daily.sh dispatches without passing `date`. The workflow falls back to UTC,\n" +
      "    which is the split this lint closes. Pass SNAP_DATE on every dispatch.",
  );
}

// ── the publisher: the day it announces a cut under ─────────────────────────
const cut = readFileSync(join(ROOT, "scripts/lib/nightly-date.mjs"), "utf8");
if (/getUTC(FullYear|Month|Date)/.test(cut) || /toISOString\(\)\.slice\(0,\s*10\)/.test(cut)) {
  failures.push(
    "scripts/lib/nightly-date.mjs now reads the day in UTC, but scripts/release-daily.sh labels\n" +
      "    the cut with the LOCAL day. Move both or neither: a nightly with two names is how this\n" +
      "    broke the first time.",
  );
}

if (failures.length > 0) {
  console.error("lint:one-release-clock FAILED — a nightly would get two different dates\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log("lint:one-release-clock: ok — the image tag and the changelog read the same day.");
