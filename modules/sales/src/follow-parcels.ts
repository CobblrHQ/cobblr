// "Follow parcels I send": where each shipped order's parcel is, until it is
// delivered.
//
// Purchases and scanned receipts follow what a workspace RECEIVES; nothing
// followed what a shop SENDS, so a delivery was learned only by opening the
// order. This follows a shipped order's tracking number on the shared cadence
// (core-shipments' cadence.ts, windows at 05:00, 09:00 and 19:00), writes each
// change onto the order, and puts "delivered" on its history, in the workspace
// log and on the bus (sales.order.delivered), so a wire can close the order or
// thank the customer.
//
// The rules the owner set when this was decided (#4365):
//   - OFF until a person turns it on, in Sales settings. Turning it on records
//     who did: the sweep asks as that person, so their own connection (their
//     personal bridge first) is the one used. The platform never pays: there
//     is no Cobblr-owned carrier or aggregator key behind this.
//   - A sent parcel stops 2 days after its delivered scan, not the 14 a
//     recipient gets: nobody confirms a customer's doorstep for the shop.
//   - A bridge is live work on somebody's machine. A round asks its parcels one
//     at a time, in series, never in parallel (the EasyPost wire format a
//     bridge speaks has no read of several numbers at once, and core does not
//     invent one), and the round stops at the first "busy" or "at capacity",
//     leaving the rest for after the wait the service asked for.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB } from "./db.js";
import { closeDeliveredOrder } from "./close-delivered.js";
import { orderHappened } from "./history.js";

export const FOLLOW_PASS = "sales.follow-sent-parcels";
const SETTING = "follow_sent_parcels";
/** How long a sent parcel is watched after its delivered scan. */
export const WATCH_DAYS_AFTER_DELIVERY = 2;
/** At most this many parcels asked about in one round, in series. */
const ROUND = 20;
const HOUR_MS = 3_600_000;
/** How long to leave a service alone after it said it was busy without saying
 *  for how long, and after it said it was full. */
const BUSY_PAUSE_MS = HOUR_MS;
const FULL_PAUSE_MS = 24 * HOUR_MS;

export interface FollowSetting {
  on: boolean;
  /** Who turned it on: the sweep asks as them, through their connection. */
  by: string | null;
  /** The service asked to be left alone until then. */
  paused_until: string | null;
  /** Why the last round stopped short, in words for the settings panel. */
  paused_reason: "busy" | "quota_exhausted" | "not_connected" | "no_driver" | null;
}

const OFF: FollowSetting = { on: false, by: null, paused_until: null, paused_reason: null };

export async function readFollowSetting(db: Kysely<SalesDB>): Promise<FollowSetting> {
  const row = await db.selectFrom("sales_settings").select("value").where("key", "=", SETTING).executeTakeFirst();
  return { ...OFF, ...((row?.value ?? {}) as Partial<FollowSetting>) };
}

async function writeFollowSetting(db: Kysely<SalesDB>, next: FollowSetting): Promise<void> {
  const value = JSON.stringify(next);
  await db
    .insertInto("sales_settings")
    .values({ key: SETTING, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: new Date() }))
    .execute();
}

/** Turn following on (as `userId`) or off. Turning it on clears a pause. */
export async function setFollowing(db: Kysely<SalesDB>, orgId: string, userId: string | null, on: boolean): Promise<FollowSetting> {
  const next: FollowSetting = on ? { on: true, by: userId, paused_until: null, paused_reason: null } : { ...OFF };
  await writeFollowSetting(db, next);
  await platform().activity.log({
    orgId,
    userId,
    action: on ? "parcel_following_on" : "parcel_following_off",
    ref: { module: "sales", entityType: "settings", entityId: SETTING },
    diff: { on },
  });
  return next;
}

export interface RoundResult {
  asked: number;
  delivered: number;
  /** Why the round asked nothing or stopped early, if it did. */
  stopped: FollowSetting["paused_reason"] | "off" | "paused" | null;
}

interface TrackAnswer {
  followed?: boolean;
  reason?: string | null;
  status?: { state?: string; deliveredAt?: string | null; carrier?: string | null };
  nextPollAt?: string | null;
}

/** One round for one workspace: every shipped order due to be asked about,
 *  in series, until one says the service is busy or full. `now` is the clock;
 *  `ignorePause` is a person pressing "Check now". */
export async function followRound(
  db: Kysely<SalesDB>,
  orgId: string,
  now: Date,
  opts: { ignorePause?: boolean } = {},
): Promise<RoundResult> {
  const setting = await readFollowSetting(db);
  if (!setting.on) return { asked: 0, delivered: 0, stopped: "off" };
  if (!opts.ignorePause && setting.paused_until && Date.parse(setting.paused_until) > now.getTime()) {
    return { asked: 0, delivered: 0, stopped: "paused" };
  }
  const watchFrom = new Date(now.getTime() - WATCH_DAYS_AFTER_DELIVERY * 24 * HOUR_MS);
  const due = await db
    .selectFrom("sales_orders")
    .select(["id", "tracking_number", "shipment_state", "shipment_checked_at", "delivered_at"])
    .where("status", "in", ["shipped", "closed"])
    .where("tracking_number", "is not", null)
    .where("tracking_number", "!=", "")
    .where((eb) => eb.or([eb("delivered_at", "is", null), eb("delivered_at", ">", watchFrom)]))
    .where((eb) => eb.or([eb("shipment_next_poll_at", "is", null), eb("shipment_next_poll_at", "<=", now)]))
    .orderBy(sql`shipment_next_poll_at asc nulls first`)
    .orderBy("shipped_at", "desc")
    .limit(ROUND)
    .execute();

  let asked = 0;
  let delivered = 0;
  for (const o of due) {
    const res = (await platform().actions.invoke("core-shipments:track", {
      orgId,
      // The person who turned following on: their own connection, and their
      // bridge, answer for the workspace's parcels.
      userId: setting.by,
      event: {
        name: FOLLOW_PASS,
        payload: {},
        actor: { user_id: setting.by, display_name: null, auth_method: "system" },
        timestamp: now.toISOString(),
        trigger_type: "schedule",
      },
      args: {
        number: o.tracking_number,
        lastState: o.shipment_state,
        lastCheckedAt: o.shipment_checked_at ? new Date(o.shipment_checked_at).toISOString() : null,
        deliveredAt: o.delivered_at ? new Date(o.delivered_at).toISOString() : null,
        watchDaysAfterDelivery: WATCH_DAYS_AFTER_DELIVERY,
        confirmed: false,
      },
    })) as TrackAnswer | null;
    asked++;

    const reason = res?.reason ?? null;
    if (reason === "busy" || reason === "quota_exhausted" || reason === "not_connected" || reason === "no_driver") {
      // The service (or the lack of one) speaks for every parcel: stop here
      // and leave the rest for later rather than ask it again and again.
      const waitMs = reason === "busy" ? (res?.nextPollAt ? Math.max(0, Date.parse(res.nextPollAt) - now.getTime()) : BUSY_PAUSE_MS) : FULL_PAUSE_MS;
      await writeFollowSetting(db, { ...setting, paused_until: new Date(now.getTime() + waitMs).toISOString(), paused_reason: reason });
      return { asked, delivered, stopped: reason };
    }

    const nextAt = res?.nextPollAt ? new Date(res.nextPollAt) : null;
    const state = res?.followed ? (res.status?.state ?? null) : o.shipment_state;
    const landed = state === "delivered" && !o.delivered_at;
    const deliveredAt = landed ? new Date(res?.status?.deliveredAt ?? now) : o.delivered_at;
    await db
      .updateTable("sales_orders")
      .set({ shipment_state: state, shipment_checked_at: now, shipment_next_poll_at: nextAt, delivered_at: deliveredAt, updated_at: new Date() })
      .where("id", "=", o.id)
      .execute();
    if (landed) {
      delivered++;
      await orderHappened(db, orgId, o.id, {
        kind: "delivered",
        detail: { tracking_number: o.tracking_number, carrier: res?.status?.carrier ?? null, at: deliveredAt?.toISOString() ?? null },
        by_user: null,
      });
      await platform().events.emit("sales.order.delivered", { orgId, orderId: o.id, deliveredAt: deliveredAt?.toISOString() ?? null });
    }
    await closeDeliveredOrder(db, orgId, o.id);
  }
  // A clean round lifts an old pause.
  if (setting.paused_reason) await writeFollowSetting(db, { ...setting, paused_until: null, paused_reason: null });
  return { asked, delivered, stopped: null };
}

/** The hourly visit, on the kernel's sweep (one walk, one connection budget). */
export function registerFollowSweep(): void {
  platform().sweeps.register({
    name: FOLLOW_PASS,
    everyMs: HOUR_MS,
    module: "sales",
    visit: async ({ orgId, db, now }) => {
      try {
        await followRound(db as Kysely<SalesDB>, orgId, now);
      } catch (err) {
        // A workspace whose sales migrations have not caught up yet.
        if (!(err as Error).message.includes("does not exist")) throw err;
      }
    },
  });
}
