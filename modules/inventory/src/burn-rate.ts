// P3 — burn-rate prediction (consumption capture, the "predict, don't wait for
// empty" rung). The consumption ledger (inventory_consumption) already records
// every negative delta = a consume event. From that cadence we learn how fast a
// part is used and PREDICT the run-out date, so the reorder fires a few days
// AHEAD of empty instead of at zero. Zero taps: it reads history you generated
// for free.
//
// An hourly sweeper (modelled on lists' expiry sweeper) computes a rate per
// part, caches it to metadata.burn (so the UI can show "≈ 4 days left"), and
// emits inventory.stock.predicted-low when the predicted-out date lands inside
// the lead window — which a bundle wires to the shopping list, same as
// stock.low. Skips items that have their own signal (tracked_by external
// systems, or a replace-clock).

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "./db.js";

const TICK_MS = 60 * 60 * 1000; // hourly
const WINDOW_DAYS = 90; // trailing history considered
const LEAD_DAYS = 5; // warn this many days before predicted-out
const MIN_EVENTS = 2; // need at least this many consume events to trust a rate
const DAY = 86_400_000;
export const BURN_RATE_PASS = "inventory.burn-rate-sweep";

export function startBurnRateSweeper(): void {
  // The walk is the kernel's (platform().sweeps, #3036): this registers the
  // per-workspace visit and its cadence and owns no timer, so the pass shares
  // one walk and one connection budget with every other pass.
  platform().sweeps.register({
    name: BURN_RATE_PASS,
    everyMs: TICK_MS,
    module: "inventory",
    visit: ({ orgId, db, now }) => visitWorkspace(orgId, db, now),
  });
  console.log(`[inventory] burn-rate sweeper registered — hourly, ${WINDOW_DAYS}d window, ${LEAD_DAYS}d lead`);
}

/** Nothing to stop: the kernel's walk owns the timer. Kept for the module's shutdown hook. */
export function stopBurnRateSweeper(): void {}

export interface ConsumptionAgg {
  /** total units consumed in the window (a positive number) */
  consumed: number;
  /** timestamp of the earliest consume event in the window */
  firstAt: Date;
  /** number of consume events */
  n: number;
}

/** Pure prediction: from a part's consume aggregate + its current on-hand,
 *  derive a per-day burn rate and the run-out date. Null when there isn't
 *  enough signal (fewer than MIN_EVENTS events, or a non-positive rate) — we
 *  never guess from noise. Rate = consumed / max(1d, span since first event);
 *  predicted-out = now + qty / rate. */
export function predictOut(
  agg: ConsumptionAgg,
  qtyNow: number,
  now: Date,
  opts?: { minEvents?: number },
): { ratePerDay: number; predictedOutAt: Date } | null {
  const minEvents = opts?.minEvents ?? MIN_EVENTS;
  if (agg.n < minEvents || agg.consumed <= 0 || qtyNow <= 0) return null;
  const spanDays = Math.max(1, (now.getTime() - agg.firstAt.getTime()) / DAY);
  const ratePerDay = agg.consumed / spanDays;
  if (!(ratePerDay > 0)) return null;
  const daysLeft = qtyNow / ratePerDay;
  return { ratePerDay, predictedOutAt: new Date(now.getTime() + daysLeft * DAY) };
}

async function burnTick(orgId?: string): Promise<{ scanned: number; warned: number }> {
  const run = await platform().sweeps.run(BURN_RATE_PASS, { orgIds: orgId ? [orgId] : undefined });
  let scanned = 0;
  let warned = 0;
  for (const { result } of run.results) {
    const r = result as Partial<{ scanned: number; warned: number }> | void;
    scanned += r?.scanned ?? 0;
    warned += r?.warned ?? 0;
  }
  return { scanned, warned };
}

/** One workspace, the pool already open: the pass's visit. `org` and `raw`
 *  keep their names so the body reads as it did when it was the loop's. */
async function visitWorkspace(orgId: string, raw: unknown, now: Date): Promise<{ scanned: number; warned: number } | void> {
  const org = { id: orgId };
  let scanned = 0;
  let warned = 0;
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * DAY);
  {
    {
      {
      const db = raw as Kysely<InventoryDB>;
      // One aggregate query: consume totals per part over the window.
      const aggs = await db
        .selectFrom("inventory_consumption")
        .select([
          "part_id",
          sql<string>`sum(-delta::numeric)`.as("consumed"),
          sql<Date>`min(at)`.as("first_at"),
          sql<string>`count(*)`.as("n"),
        ])
        .where("at", ">", cutoff)
        .where(sql<boolean>`delta::numeric < 0`)
        .groupBy("part_id")
        .execute();
      if (aggs.length === 0) return;

      const parts = await db
        .selectFrom("inventory_parts")
        .select(["id", "qty", "metadata"])
        .where(
          "id",
          "in",
          aggs.map((a) => a.part_id),
        )
        // Archiving something is the user saying "stop". Predicting a run-out
        // for it and pushing that onto the shopping list ignores the one
        // explicit instruction they gave, which is worse than never having
        // offered the prediction.
        .where("archived", "=", false)
        .execute();
      const byId = new Map(parts.map((p) => [p.id, p]));

      for (const a of aggs) {
        const part = byId.get(a.part_id);
        if (!part) continue;
        scanned++;
        const md = (part.metadata as Record<string, unknown> | null) ?? {};
        // Items with their own signal opt out: externally tracked, or governed
        // by a replace-clock (that fires replace-due instead).
        if (md.tracked_by || md.replace_every_days || md.replace_rrule) continue;
        const qtyNow = Number(part.qty);
        const pred = predictOut(
          { consumed: Number(a.consumed), firstAt: new Date(a.first_at), n: Number(a.n) },
          qtyNow,
          now,
        );

        const burnPrev = (md.burn as Record<string, unknown> | undefined) ?? {};
        if (!pred) {
          continue;
        }
        const outIso = pred.predictedOutAt.toISOString();
        const outDay = outIso.slice(0, 10);
        const withinLead = pred.predictedOutAt.getTime() <= now.getTime() + LEAD_DAYS * DAY;
        // Cache the estimate (UI: "≈ N days left") regardless of warning.
        const burn: Record<string, unknown> = {
          rate_per_day: Number(pred.ratePerDay.toFixed(4)),
          predicted_out_at: outIso,
          computed_at: now.toISOString(),
          warned_for: burnPrev.warned_for ?? null,
        };
        // Warn once per predicted-out day — a restock pushes the date out and
        // re-arms; re-warns only when it crosses back into the window at a new
        // date. Avoids hourly shopping-list spam.
        if (withinLead && burnPrev.warned_for !== outDay) {
          burn.warned_for = outDay;
          await platform().events.emit("inventory.stock.predicted-low", {
            orgId: org.id,
            partId: a.part_id,
            newQty: qtyNow,
            predictedOutAt: outIso,
            ratePerDay: burn.rate_per_day,
          });
          warned++;
        }
        await db
          .updateTable("inventory_parts")
          .set({
            metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ burn })}::jsonb`,
          })
          .where("id", "=", a.part_id)
          .execute();
      }
      }
    }
  }
  return { scanned, warned };
}

/** Exposed for tests / a manual trigger. */
export const _burnTick = burnTick;
