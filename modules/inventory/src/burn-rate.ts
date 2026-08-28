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

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startBurnRateSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 45_000); // first pass once boot settles
  console.log(`[inventory] burn-rate sweeper started — hourly, ${WINDOW_DAYS}d window, ${LEAD_DAYS}d lead`);
}

export function stopBurnRateSweeper(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[inventory] burn-rate sweeper stopped");
  }
}

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

async function safeTick(): Promise<void> {
  try {
      // One process only: every api runs this loop, and more than one api
      // runs against a single database (the canary channel; a rolling deploy).
      // Unguarded, each tick's notifications and writes happen twice.
    await platform().exclusive.run("inventory.burn-rate-sweep", async () => {
      await burnTick();
    });
  } catch (err) {
    console.error("[inventory] burn-rate tick failed:", (err as Error).message);
  }
}

async function burnTick(orgId?: string): Promise<{ scanned: number; warned: number }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) => j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "inventory"))
    .select(["orgs.id"]);
  if (orgId) orgsQ = orgsQ.where("orgs.id", "=", orgId);
  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[inventory] burn sweep skipped — meta read failed:", (err as Error).message);
    return { scanned: 0, warned: 0 };
  }

  let scanned = 0;
  let warned = 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * DAY);

  for (const org of orgs) {
    try {
      // withDb releases the org's pool the moment this closure returns — a
      // getDb + releaseIdleDb pair can't release its own pool inside the
      // grace window, which held one pool per tenant and exhausted Postgres.
      await platform().tenants.withDb(org.id, async (raw) => {
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
      });
    } catch (err) {
      console.error(`[inventory] burn sweep for org ${org.id} failed:`, (err as Error).message);
    }
  }
  return { scanned, warned };
}

/** Exposed for tests / a manual trigger. */
export const _burnTick = burnTick;
