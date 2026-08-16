// Following a parcel that is still sitting in the inbox.
//
// A receipt with a tracking number describes something on its way, and that is
// true whether or not anyone has filed it into a purchase order. Filing is a
// bookkeeping decision; the parcel moves either way. Requiring the filing first
// meant capture-first worked for everything except the one thing with a
// deadline attached.
//
// So this sweeps the inbox's own tracked receipts. It is deliberately the same
// shape as purchases' arrival sweeper and calls the SAME capability
// (`core-shipments:track`), so the cadence, the ranking and the "is it even
// worth asking" rules live in one place and neither caller reimplements them.
// What differs is only the subject and what happens on arrival: an order asks
// "did it turn up?", an inbox receipt says "it is here, want to file it?".
//
// Per-org isolation and withDb so a tenant pool cannot outlive the closure
// (CLAUDE.md section 8.1).

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // hourly; the capability's cadence is what makes it sparse

export function startReceiptTrackingSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 50_000); // after boot settles, and after purchases' sweep
  console.log(`[core-scan] receipt tracking sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await receiptTrackingTick();
  } catch (err) {
    console.error("[core-scan] receipt tracking sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

interface TrackedRow {
  id: string;
  label: string | null;
  vendor: string | null;
  tracking_number: string;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  shipment_notified_state: string | null;
  pending_items: number;
}

/** The states worth interrupting someone for. `out_for_delivery` earns a
 *  message because it is the one that changes what you do TODAY; the rest of
 *  the journey is visible in the inbox without being pushed at anyone. */
const NOTIFY_STATES = new Set(["delivered", "out_for_delivery"]);

export function messageFor(state: string, what: string): string {
  return state === "delivered"
    ? `${what} was delivered. File it when you have it in hand.`
    : `${what} is out for delivery today.`;
}

/** A human name for the parcel, preferring what the person would recognise. */
export function subjectOf(row: { vendor: string | null; label: string | null }): string {
  const vendor = (row.vendor ?? "").trim();
  if (vendor) return `Your ${vendor} order`;
  const label = (row.label ?? "").trim();
  return label || "A parcel you are tracking";
}

/** One sweep. Exported so a test or a CLI can fire it deterministically. */
export async function receiptTrackingTick(
  opts: { orgId?: string; now?: Date } = {},
): Promise<{ checked: number; notified: number }> {
  const now = opts.now ?? new Date();
  let checked = 0;
  let notified = 0;

  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) =>
      j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "core-scan"),
    )
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);

  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[core-scan] tracking sweep skipped — meta read failed:", (err as Error).message);
    return { checked: 0, notified: 0 };
  }

  for (const { id: orgId } of orgs) {
    try {
      await platform().tenants.withDb(orgId, async (raw) => {
        const tdb = raw as Kysely<unknown>;
        // Only receipts still WAITING to be filed. Once every line has been
        // confirmed or discarded the inbox is done with it, and the order (if
        // one was made) carries the tracking from there.
        const q = sql<TrackedRow>`
          select b.id,
                 b.label,
                 b.vendor,
                 b.tracking_number,
                 b.shipment_state,
                 b.shipment_checked_at,
                 b.shipment_notified_state,
                 count(i.id) filter (where i.status in ('pending','enriching')) as pending_items
            from core_scan_batches b
            join core_scan_inbox_items i on i.scan_batch_id = b.id
           where nullif(btrim(coalesce(b.tracking_number, '')), '') is not null
           group by b.id
          having count(i.id) filter (where i.status in ('pending','enriching')) > 0
        `.compile(tdb);

        let rows: TrackedRow[];
        try {
          rows = ((await tdb.executeQuery(q)) as { rows: TrackedRow[] }).rows;
        } catch (err) {
          // A workspace whose core-scan migrations have not caught up yet.
          if ((err as Error).message.includes("does not exist")) return;
          throw err;
        }

        for (const row of rows) {
          try {
            const res = (await platform().actions.invoke("core-shipments:track", {
              orgId,
              userId: null,
              event: {
                name: "core-scan.receipt-tracking-sweep",
                payload: {},
                actor: { user_id: null, display_name: null, auth_method: "system" },
                timestamp: now.toISOString(),
                trigger_type: "schedule",
              },
              args: {
                number: row.tracking_number,
                lastState: row.shipment_state,
                lastCheckedAt: row.shipment_checked_at?.toISOString() ?? null,
                // Nothing in the inbox has been taken in and put away yet --
                // that is what filing it means. Said explicitly so the
                // capability never has to infer it.
                confirmed: false,
              },
            })) as {
              followed?: boolean;
              status?: { state?: string; description?: string; location?: string | null };
              nextPollAt?: string | null;
            } | null;

            if (!res?.followed || !res.status?.state) continue;
            checked += 1;

            const state = res.status.state;
            await tdb.executeQuery(
              sql`
                update core_scan_batches
                   set shipment_state         = ${state},
                       shipment_description   = ${res.status.description ?? null},
                       shipment_location      = ${res.status.location ?? null},
                       shipment_checked_at    = ${now},
                       shipment_next_poll_at  = ${res.nextPollAt ? new Date(res.nextPollAt) : null}
                 where id = ${row.id}
              `.compile(tdb),
            );

            // Tell someone only when the state is worth acting on, and only
            // once per state -- a parcel sits 'delivered' until it is filed, and
            // an hourly reminder of that is noise, not service.
            if (NOTIFY_STATES.has(state) && row.shipment_notified_state !== state) {
              await notifyArrival(orgId, row, state);
              notified += 1;
              await tdb.executeQuery(
                sql`update core_scan_batches set shipment_notified_state = ${state} where id = ${row.id}`.compile(
                  tdb,
                ),
              );
            }
          } catch (err) {
            // A carrier or bridge being down is not an arrival. Skip this
            // parcel and let the next tick try again.
            console.warn(`[core-scan] tracking check failed for receipt ${row.id}:`, (err as Error).message);
          }
        }
      });
    } catch (err) {
      // One workspace's failure never stops the rest.
      console.warn(`[core-scan] tracking sweep failed for org ${orgId}:`, (err as Error).message);
    }
  }

  if (checked || notified) {
    console.log(`[core-scan] receipt tracking: ${checked} checked, ${notified} announced`);
  }
  return { checked, notified };
}

/** Say it landed, and point at the place the person can act on it. */
async function notifyArrival(orgId: string, row: TrackedRow, state: string): Promise<void> {
  // Only now, with something to say, do we pay for the member list.
  const memberIds = await platform().notifications.orgMemberIds(orgId);
  const message = messageFor(state, subjectOf(row));
  for (const userId of memberIds) {
    try {
      await platform().notifications.dispatch({
        orgId,
        userId,
        eventType: "core-scan.parcel.update",
        message,
        module: "core-scan",
        // The inbox, because that is where the receipt still is and where the
        // next action lives. dispatch does NOT derive a link from the entity
        // fields — it passes link_url straight through, so omitting it leaves
        // the notification with nowhere to go (the arrivals bug, 2026-08).
        link_url: "/scan",
        payload: { state, tracking_number: row.tracking_number },
      });
    } catch (err) {
      console.error("[core-scan] parcel notify failed:", (err as Error).message);
    }
  }
}
