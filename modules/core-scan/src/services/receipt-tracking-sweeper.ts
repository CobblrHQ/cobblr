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
import { arrivedEverywhere, parcelAudience } from "@cobblr/platform-contract";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // hourly; the capability's cadence is what makes it sparse

export function startReceiptTrackingSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 50_000); // after boot settles, and after purchases' sweep
  console.log(`[core-scan] receipt tracking sweeper started — every ${TICK_MS / 60_000} min`);

  // A bridge push means the carrier already answered: re-check that number NOW,
  // off-cadence, instead of letting the news wait for the next polling window.
  // The push itself carries no status — the bell is trusted, the data is not —
  // so this runs the same tick, forced, and the state still comes through the
  // authenticated read path.
  platform().events.on("core-shipments.tracker.pushed", "core-scan", async (payload: unknown) => {
    const p = payload as { orgId?: string; tracking_number?: string };
    if (!p.orgId || !p.tracking_number) return;
    try {
      await receiptTrackingTick({ orgId: p.orgId, number: p.tracking_number, force: true });
    } catch (err) {
      console.error("[core-scan] pushed tracker re-check failed:", (err as Error).message);
    }
  });
}

async function safeTick(): Promise<void> {
  try {
      // One process only: every api runs this loop, and more than one api
      // runs against a single database (the canary channel; a rolling deploy).
      // Unguarded, each tick's notifications and writes happen twice.
    await platform().exclusive.run("core-scan.receipt-tracking-sweep", async () => {
      await receiptTrackingTick();
    });
  } catch (err) {
    console.error("[core-scan] receipt tracking sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
}

interface TrackedRow {
  id: string;
  label: string | null;
  vendor: string | null;
  tracking_number: string | null;
  tracking_added_by_user_id: string | null;
  created_by_user_id: string | null;
  /** The date the RECEIPT itself promised, parsed at ingest and kept on the
   *  items' metadata. Independent of any carrier. */
  expected_arrival: string | null;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  shipment_notified_state: string | null;
  /** Set when the receipt already has its purchases order - the order's own
   *  sweep announces then, this one stays quiet. */
  purchases_order_id: string | null;
  pending_items: number;
}

/** The states worth interrupting someone for. `out_for_delivery` earns a
 *  message because it is the one that changes what you do TODAY; the rest of
 *  the journey is visible in the inbox without being pushed at anyone. */
const NOTIFY_STATES = new Set(["delivered", "out_for_delivery"]);

/** Marker for the date-only ask, so it happens once. Not a carrier state, and
 *  deliberately not one: it means "its own receipt said today". */
const DUE_MARK = "date-due";

/** What (if anything) to tell the owner about this parcel, deciding against
 *  everything KNOWN — the fresh answer when there is one, else the stored
 *  state — and never repeating what was already announced.
 *
 *  The stored state matters because a tick can legitimately answer nothing: a
 *  parcel checked ten minutes ago is "not due", which returns no state. The
 *  old decision read that absence as "the carrier has never spoken" and fell
 *  through to the date-due question — so a restart (boot runs a tick) asked
 *  "did it turn up?" about a parcel whose own row said delivered, ten minutes
 *  after announcing the delivery. Both DMs are in the 2026-08-25 screenshot
 *  that reported this.
 *
 *  Pure, so the restart case is assertable without a database. */
export function announceFor(
  freshState: string | null,
  row: {
    shipment_state: string | null;
    shipment_notified_state: string | null;
    expected_arrival: string | null;
  },
  now: Date,
): string | null {
  const known = freshState ?? row.shipment_state;
  const announce =
    known && NOTIFY_STATES.has(known)
      ? known
      : !known && row.expected_arrival && row.expected_arrival <= arrivedEverywhere(now)
        ? DUE_MARK
        : null;
  return announce && announce !== row.shipment_notified_state ? announce : null;
}

export function messageFor(state: string, what: string): string {
  if (state === "delivered") return `${what} was delivered. File it when you have it in hand.`;
  if (state === "out_for_delivery") return `${what} is out for delivery today.`;
  // The date-only case. No carrier has said anything -- the receipt itself
  // named a day and the day has come -- so it ASKS rather than announces.
  return `${what} was due today. Did it turn up?`;
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
  opts: { orgId?: string; now?: Date; number?: string; force?: boolean } = {},
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
        // Followable OR simply due. A receipt that named a delivery date is
        // worth asking about even when nobody ever added a tracking number --
        // that is the majority of receipts, and the case that used to fall
        // through both sweeps and produce silence.
        const today = arrivedEverywhere(now);
        const q = sql<TrackedRow>`
          select b.id,
                 b.label,
                 b.vendor,
                 b.tracking_number,
                 b.tracking_added_by_user_id,
                 b.created_by_user_id,
                 b.shipment_state,
                 b.shipment_checked_at,
                 b.shipment_notified_state,
                 b.purchases_order_id,
                 max(i.suggested_metadata->>'expected_arrival') as expected_arrival,
                 count(i.id) filter (where i.status in ('pending','enriching')) as pending_items
            from core_scan_batches b
            join core_scan_inbox_items i on i.scan_batch_id = b.id
           -- A confirmed parcel is FINISHED — the user said it is in hand.
           where b.shipment_confirmed_at is null
           group by b.id
          having (
                   -- still being triaged, and either followable or simply due
                   count(i.id) filter (where i.status in ('pending','enriching')) > 0
                   and (
                     nullif(btrim(coalesce(b.tracking_number, '')), '') is not null
                     or max(i.suggested_metadata->>'expected_arrival') <= ${today}
                   )
                 )
                 -- or its lines are filed but the parcel is still in the air.
                 -- Confirming items one at a time used to end the watch early:
                 -- the receipt left the inbox and took its tracking with it.
                 or (
                   nullif(btrim(coalesce(b.tracking_number, '')), '') is not null
                   and coalesce(b.shipment_state, '') <> 'delivered'
                 )
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
          // A pushed re-check is about ONE parcel; leave the rest on cadence.
          if (opts.number && row.tracking_number !== opts.number) continue;
          try {
            // Ask the carrier only when there is a number to ask about. A
            // receipt with just a date skips straight to the question below.
            type TrackResult = {
              followed?: boolean;
              reason?: string;
              status?: { state?: string; description?: string; location?: string | null };
              nextPollAt?: string | null;
            } | null;
            let res: TrackResult = null;
            if (row.tracking_number) {
              res = (await platform().actions.invoke("core-shipments:track", {
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
                  // The receipt's own promised date. Without it the cadence
                  // cannot see arrival day, so a fast parcel got one poll a
                  // day and lived its whole out-for-delivery -> delivered life
                  // inside the gap (the 2026-08-25 laptop: due "today" per its
                  // receipt, checked at 05:35 as pre_transit, next look
                  // scheduled for TOMORROW — delivered at 19:49 with nobody
                  // told). purchases' sweeper always passed this; the two are
                  // meant to be the same shape, and this was the drift.
                  currentEta: row.expected_arrival,
                  currentEtaSource: row.expected_arrival ? "receipt" : "none",
                  lastState: row.shipment_state,
                  lastCheckedAt: row.shipment_checked_at?.toISOString() ?? null,
                  // When we first saw 'delivered' - closes the dispute window,
                  // which otherwise never elapsed and polled forever.
                  deliveredAt:
                    row.shipment_state === "delivered" ? row.shipment_checked_at?.toISOString() ?? null : null,
                  // Nothing in the inbox has been taken in and put away yet --
                  // that is what filing it means. Said explicitly so the
                  // capability never has to infer it.
                  confirmed: false,
                  // A push means the carrier already answered; skip the
                  // is-it-due gate for this one read.
                  ...(opts.force ? { force: true } : {}),
                },
              })) as TrackResult;
            }

            if (res?.followed && res.status?.state) checked += 1;

            const state = res?.status?.state ?? null;
            if (state) {
              await tdb.executeQuery(
                sql`
                  update core_scan_batches
                     set shipment_state         = ${state},
                         shipment_description   = ${res?.status?.description ?? null},
                         shipment_location      = ${res?.status?.location ?? null},
                         shipment_checked_at    = ${now},
                         shipment_next_poll_at  = ${res?.nextPollAt ? new Date(res.nextPollAt) : null}
                   where id = ${row.id}
                `.compile(tdb),
              );
            } else if (row.tracking_number) {
              // The attempt itself is what the cadence paces. Stamping
              // checked_at only on success meant an unrecognised or failing
              // number kept lastCheckedAt null, was always "due", and was
              // re-attempted on EVERY hourly tick for the life of the
              // workspace (2026-08-25 audit).
              //
              // And say WHY there is nothing: "Not checked yet" forever on an
              // unrecognised number reads as our failure, when the honest
              // answer is that no carrier matches it - probably a typo worth
              // fixing via Edit number.
              const why =
                res?.reason === "unrecognised"
                  ? "No carrier recognises this number - check it for typos"
                  : null;
              await tdb.executeQuery(
                sql`update core_scan_batches
                       set shipment_checked_at = ${now},
                           shipment_description = coalesce(${why}, shipment_description)
                     where id = ${row.id}`.compile(tdb),
              );
            }

            // Tell someone only when the state is worth acting on, and only
            // once per state -- a parcel sits 'delivered' until it is filed, and
            // an hourly reminder of that is noise, not service.
            // Two independent reasons to speak, and the date one must NOT be
            // gated on the carrier: a receipt with no tracking number still
            // named a day, and that day passing is the whole question.
            const announce = announceFor(state, row, now);
            // One parcel, one announcement. Once the number is on the ORDER
            // (the tracking PATCH propagates it), purchases' sweep asks the
            // better question - "was delivered. Put it away?" with a working
            // mark-arrived button - so this one stays quiet rather than
            // sending a second, weaker message for the same box.
            const orderOwnsTheAnnouncement = Boolean(row.purchases_order_id && row.tracking_number);
            if (announce && !orderOwnsTheAnnouncement) {
              // Marker FIRST, then send: a crash between the two now costs one
              // missed message instead of the same message to every member on
              // every tick until someone notices (2026-08-25 audit). The next
              // state change still announces.
              await tdb.executeQuery(
                sql`update core_scan_batches set shipment_notified_state = ${announce} where id = ${row.id}`.compile(
                  tdb,
                ),
              );
              await notifyArrival(orgId, row, announce);
              notified += 1;
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

/** Say it landed, to the parcel's OWNER, and point at the place they act.
 *
 *  The owner is whoever added the tracking number, else whoever captured the
 *  receipt — resolved by parcelAudience, which falls back to every member only
 *  when neither is still in the workspace. Broadcasting was the old behaviour,
 *  and it meant a family workspace heard about every member's orders. */
async function notifyArrival(orgId: string, row: TrackedRow, state: string): Promise<void> {
  // Only now, with something to say, do we pay for the member list.
  const memberIds = await platform().notifications.orgMemberIds(orgId);
  const audience = parcelAudience(
    [row.tracking_added_by_user_id, row.created_by_user_id],
    new Set(memberIds),
  );
  const message = messageFor(state, subjectOf(row));
  const subject = subjectOf(row);
  // ONE rich card, answered by its button. The bare workspace link under a
  // plain sentence was the report: "everything we send in discord should be
  // that [a card] — you answer by pressing a button right in the card."
  const card = {
    heading:
      state === "delivered"
        ? `${subject} was delivered`
        : state === "out_for_delivery"
          ? `${subject} is out for delivery`
          : `${subject} was due today`,
    body:
      state === "delivered"
        ? "Press the button once it is in hand. Filing the receipt can wait."
        : state === "out_for_delivery"
          ? "It should land today. Nothing to do yet."
          : "Its receipt named today. Did it turn up?",
    ...(row.label ? { context: row.label } : {}),
  };
  // out_for_delivery is informational — a button that confirms possession of a
  // parcel still on the truck would be a lie waiting to be pressed.
  const actions =
    state === "delivered" || state === DUE_MARK
      ? [
          {
            id: "in-hand",
            label: state === DUE_MARK ? "Yes, it turned up" : "It is in hand",
            action: "core-scan:confirm-receipt-arrival",
            args: { batch_id: row.id },
            style: "primary" as const,
          },
        ]
      : undefined;
  for (const userId of audience) {
    try {
      await platform().notifications.dispatch({
        orgId,
        userId,
        eventType: "core-scan.parcel.update",
        message,
        card,
        ...(actions ? { actions } : {}),
        module: "core-scan",
        // This sweeper IS the clock. Defaulting to "activity" pushed each
        // parcel at whatever hour the tick ran, past the "dated things once a
        // morning" window users chose (2026-08-25 audit).
        triggeredBy: "schedule",
        // The RECEIPT, not the inbox. A notification that names one parcel and
        // lands you on a page of thirty is a search task, and the id is right
        // here. `?batch=` scopes the inbox to one session (ScanPage).
        //
        // dispatch does NOT derive a link from the entity fields — it passes
        // link_url straight through, so omitting it leaves the notification
        // with nowhere to go at all (the arrivals bug, 2026-08).
        link_url: `/scan?batch=${row.id}`,
        payload: { state, tracking_number: row.tracking_number },
      });
    } catch (err) {
      console.error("[core-scan] parcel notify failed:", (err as Error).message);
    }
  }
}
