// Whether a one-shot heal shim still has anything to do, on this deployment.
//
// PERMANENT RECONCILE — this is not a shim itself; it is what lets the shims
// retire. Every one carries a `DONE WHEN:` line naming the condition under
// which it gets deleted (lint:heal-shims keeps the line honest), and until now
// nothing ever checked whether that condition had come true: the deletion pass
// was a person reading boot logs on every deployment, with no owner, schedule
// or trigger. That is how the lens shims sat a month past their cutover, the
// incident lint:heal-shims cites as its own reason for existing.
//
// Two things made the reading worse than it looks. A boot log dies with its
// container, so "reports 0 consistently" is unanswerable the moment a
// deployment restarts. And some deployments are not ones whose logs anybody
// reads at all, usually the ones carrying the newest users.
//
// So each pass records what it found, and /healthz reports it. `zero_since` is
// the column that matters: set the first time a pass finds nothing and fails
// nowhere, cleared the moment it finds something or cannot read a workspace.
// "Nothing anywhere since <date>" is then a fact anybody can read over HTTPS,
// and deleting a shim stops being a judgement call (#3453).
//
// Each shim records ITSELF, keyed by its own repo path, so the answer names
// the file to delete and lint:heal-shims can hold every `DONE WHEN:` file to
// recording (or to saying why its condition is not a count).
import { meta } from "../db/meta.js";

/** What one deployment knows about one shim. */
export interface HealShimRun {
  shim: string;
  last_run_at: Date;
  last_found: number;
  last_failed: number;
  zero_since: Date | null;
}

/** Why a pass's result is not recorded: it never looked. A pass told to skip
 *  history returns zero by construction, and a zero it never measured must
 *  not start the clock that deletes it. */
function skipped(): boolean {
  return process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1";
}

const count = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

/** Record what a pass found. `found` is how much of its DONE WHEN was still
 *  untrue when it looked, in the unit the condition speaks in (workspaces,
 *  rows): what it FOUND, not what it fixed, because a candidate it skips
 *  (ambiguous, refused) still stands between the shim and its deletion.
 *  `failed` is how many workspaces it could not read, whose candidates it
 *  therefore never counted. Only a pass that found nothing AND failed nowhere
 *  counts toward retirement. Never throws: a boot must not fail because a
 *  bookkeeping row would not write. */
export async function noteHealShim(shim: string, found: number, failed = 0, now: Date = new Date()): Promise<void> {
  if (skipped()) return;
  const t = count(found);
  const f = count(failed);
  const clean = t === 0 && f === 0;
  try {
    await meta
      .insertInto("heal_shim_runs")
      .values({ shim, last_run_at: now, last_found: t, last_failed: f, zero_since: clean ? now : null })
      .onConflict((oc) =>
        oc.column("shim").doUpdateSet((eb) => ({
          last_run_at: now,
          last_found: t,
          last_failed: f,
          // Clean: keep the date it first went clean, or start it now.
          // Anything else restarts the clock.
          zero_since: clean ? eb.fn.coalesce("heal_shim_runs.zero_since", eb.val(now)) : eb.val(null),
        })),
      )
      .execute();
    cache = null;
  } catch (err) {
    console.warn(`[heal-shims] could not record ${shim}:`, (err as Error).message);
  }
}

let cache: { at: number; rows: HealShimRun[] } | null = null;
const CACHE_MS = 5_000;

/** Every shim's last word on this deployment, for /healthz. `null` when the
 *  table cannot be read: a deployment that cannot answer is not one that
 *  answered "nothing recorded", and the reader has to be able to tell.
 *  Cached for a few seconds, because /healthz is polled by every open tab
 *  and these rows change only when a pass runs (which clears this
 *  process's cache; another replica's write is seen within the window). */
export async function healShimRuns(now: number = Date.now()): Promise<HealShimRun[] | null> {
  if (cache && now - cache.at < CACHE_MS) return cache.rows;
  try {
    const rows = (await meta
      .selectFrom("heal_shim_runs")
      .select(["shim", "last_run_at", "last_found", "last_failed", "zero_since"])
      .orderBy("shim", "asc")
      .execute()) as HealShimRun[];
    cache = { at: now, rows };
    return rows;
  } catch {
    return null;
  }
}
