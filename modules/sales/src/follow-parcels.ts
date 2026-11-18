import { narrowSweep } from "@cobblr/platform-contract/sweep-candidates";
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
  await platform().activity.transaction(orgId, db, async (trx, log) => {
    await writeFollowSetting(trx, next);
    await log({
      orgId,
      userId,
      action: on ? "parcel_following_on" : "parcel_following_off",
      ref: { module: "sales", entityType: "settings", entityId: SETTING },
      diff: { on },
    });
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

/** One thing to ask a carrier about: a parcel of an order, or an order that
 *  shipped before orders kept parcels and carries its own tracking number. */
interface Unit {
  parcel_id: string | null;
  order_id: string;
  tracking_number: string | null;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  delivered_at: Date | null;
}

const watchFromOf = (now: Date) => new Date(now.getTime() - WATCH_DAYS_AFTER_DELIVERY * 24 * HOUR_MS);

/** The parcels (and unparcelled orders) due to be asked about, most overdue first. A box of an order still open is followed too:
 *  the first boxes of a part-shipped order are on their way before the last one goes out (#9556). */
async function dueUnits(db: Kysely<SalesDB>, now: Date): Promise<Unit[]> {
  const watchFrom = watchFromOf(now);
  const parcels = await db
    .selectFrom("sales_order_parcels as p")
    .innerJoin("sales_orders as o", "o.id", "p.order_id")
    .select(["p.id as parcel_id", "p.order_id", "p.tracking_number", "p.shipment_state", "p.shipment_checked_at", "p.delivered_at"])
    .where("o.status", "!=", "cancelled")
    .where("p.tracking_number", "is not", null)
    .where("p.tracking_number", "!=", "")
    .where((eb) => eb.or([eb("p.delivered_at", "is", null), eb("p.delivered_at", ">", watchFrom)]))
    .where((eb) => eb.or([eb("p.shipment_next_poll_at", "is", null), eb("p.shipment_next_poll_at", "<=", now)]))
    .orderBy(sql`p.shipment_next_poll_at asc nulls first`)
    .orderBy("p.shipped_at", "desc")
    .limit(ROUND)
    .execute();
  if (parcels.length >= ROUND) return parcels;
  const orders = await db
    .selectFrom("sales_orders")
    .select(["id as order_id", "tracking_number", "shipment_state", "shipment_checked_at", "delivered_at"])
    .where("status", "in", ["shipped", "closed"])
    .where("tracking_number", "is not", null)
    .where("tracking_number", "!=", "")
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("sales_order_parcels").select("sales_order_parcels.id").whereRef("sales_order_parcels.order_id", "=", "sales_orders.id"))))
    .where((eb) => eb.or([eb("delivered_at", "is", null), eb("delivered_at", ">", watchFrom)]))
    .where((eb) => eb.or([eb("shipment_next_poll_at", "is", null), eb("shipment_next_poll_at", "<=", now)]))
    .orderBy(sql`shipment_next_poll_at asc nulls first`)
    .orderBy("shipped_at", "desc")
    .limit(ROUND - parcels.length)
    .execute();
  return [...parcels, ...orders.map((o) => ({ ...o, parcel_id: null }))];
}

/** How many boxes are being followed right now: not delivered, with a number to ask about. */
export async function followingCount(db: Kysely<SalesDB>): Promise<number> {
  const boxes = await db
    .selectFrom("sales_order_parcels as p")
    .innerJoin("sales_orders as o", "o.id", "p.order_id")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("o.status", "!=", "cancelled")
    .where("p.tracking_number", "is not", null)
    .where("p.tracking_number", "!=", "")
    .where("p.delivered_at", "is", null)
    .executeTakeFirst();
  const alone = await db
    .selectFrom("sales_orders")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("status", "in", ["shipped", "closed"])
    .where("tracking_number", "is not", null)
    .where("tracking_number", "!=", "")
    .where("delivered_at", "is", null)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("sales_order_parcels").select("sales_order_parcels.id").whereRef("sales_order_parcels.order_id", "=", "sales_orders.id"))))
    .executeTakeFirst();
  return Number(boxes?.n ?? 0) + Number(alone?.n ?? 0);
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
  const due = await dueUnits(db, now);

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
    const sawDelivered = state === "delivered" && !o.delivered_at;
    const landedAt = sawDelivered ? new Date(res?.status?.deliveredAt ?? now) : o.delivered_at;
    let landed = sawDelivered;
    const afterCommit: Array<() => Promise<void>> = [];
    let orderDeliveredAt: Date | null = null;
    let orderLanded = false;
    await platform().activity.transaction(orgId, db, async (trx, log) => {
      const set = { shipment_state: state, shipment_checked_at: now, shipment_next_poll_at: nextAt, delivered_at: landedAt, updated_at: new Date() };
      // Another round (the hourly pass, or a person's Check now) may have read
      // this box as undelivered too and landed it first: only the round whose
      // write flips delivered_at from null says it landed.
      const table = o.parcel_id ? "sales_order_parcels" : "sales_orders";
      let write = trx.updateTable(table).set(set).where("id", "=", o.parcel_id ?? o.order_id);
      if (sawDelivered) write = write.where("delivered_at", "is", null);
      const wrote = await write.returning("id").execute();
      if (sawDelivered && wrote.length === 0) landed = false;
      if (landed) {
        await orderHappened(trx, orgId, o.order_id, {
          kind: "delivered",
          detail: { tracking_number: o.tracking_number, carrier: res?.status?.carrier ?? null, at: landedAt?.toISOString() ?? null, ...(o.parcel_id ? { parcel_id: o.parcel_id } : {}) },
          by_user: null,
        }, afterCommit, log);
      }
      if (!o.parcel_id) {
        orderDeliveredAt = landedAt;
        orderLanded = landed;
        return;
      }
      // An order is delivered when every box of it is, and not before it has
      // all gone out: an earlier box landing says nothing about the rest.
      const order = await trx.selectFrom("sales_orders").select(["status", "delivered_at"]).where("id", "=", o.order_id).forUpdate().executeTakeFirst();
      orderDeliveredAt = order?.delivered_at ?? null;
      if (!order || orderDeliveredAt || (order.status !== "shipped" && order.status !== "closed")) return;
      const boxes = await trx.selectFrom("sales_order_parcels").select("delivered_at").where("order_id", "=", o.order_id).execute();
      if (boxes.length === 0 || boxes.some((b) => !b.delivered_at)) return;
      orderDeliveredAt = new Date(Math.max(...boxes.map((b) => new Date(b.delivered_at as Date).getTime())));
      orderLanded = true;
      await trx.updateTable("sales_orders").set({ shipment_state: "delivered", delivered_at: orderDeliveredAt, updated_at: new Date() }).where("id", "=", o.order_id).execute();
    });
    for (const publish of afterCommit) await publish();
    if (orderLanded) {
      delivered++;
      await platform().events.emit("sales.order.delivered", { orgId, orderId: o.order_id, deliveredAt: (orderDeliveredAt as Date | null)?.toISOString() ?? null });
    }
    if (orderDeliveredAt) await closeDeliveredOrder(db, orgId, o.order_id);
  }
  // A clean round lifts an old pause.
  if (setting.paused_reason) await writeFollowSetting(db, { ...setting, paused_until: null, paused_reason: null });
  return { asked, delivered, stopped: null };
}

/** The hourly visit, on the kernel's sweep (one walk, one connection budget). */
export function registerFollowSweep(): void {
  platform().sweeps.register(narrowSweep({
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
  }, hasFollowWork));
}

export async function hasFollowWork({ db, now }: { db: unknown; now: Date }): Promise<boolean> {
  const k = db as Kysely<SalesDB>;
  const watchFrom = watchFromOf(now);
  const on = await k.selectFrom("sales_settings").select("key")
    .where("key", "=", SETTING).where(sql<boolean>`value->>'on' = 'true'`).executeTakeFirst();
  if (!on) return false;
  const box = await k.selectFrom("sales_order_parcels as p").innerJoin("sales_orders as o", "o.id", "p.order_id").select("p.id")
    .where("o.status", "!=", "cancelled")
    .where("p.tracking_number", "is not", null).where("p.tracking_number", "!=", "")
    .where(eb => eb.or([eb("p.delivered_at", "is", null), eb("p.delivered_at", ">", watchFrom)]))
    .limit(1).executeTakeFirst();
  if (box) return true;
  return !!await k.selectFrom("sales_orders").select("id")
    .where("status", "in", ["shipped", "closed"])
    .where("tracking_number", "is not", null).where("tracking_number", "!=", "")
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("sales_order_parcels").select("sales_order_parcels.id").whereRef("sales_order_parcels.order_id", "=", "sales_orders.id"))))
    .where(eb => eb.or([eb("delivered_at", "is", null), eb("delivered_at", ">", watchFrom)]))
    .limit(1).executeTakeFirst();
}
