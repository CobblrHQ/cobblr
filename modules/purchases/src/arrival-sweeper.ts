// The arrival question — "did it turn up?", asked once, on the day it was due.
//
// An order with an ETA is a promise about a date. When the date passes and
// nothing has marked it arrived, only the user knows the answer, so the sweep's
// whole job is to ask them at the one moment the question is worth asking, and
// then to stop.
//
// This is arrivals.md section 5, and it is the free half of shipments.md: a
// carrier could answer without asking anybody, but carrier tracking turned out
// to need an account and a card, so this covers every order rather than the
// small number on a connected carrier. When a carrier IS connected, its answer
// should pre-empt the question rather than replace this — an order with no
// tracking number still needs asking.
//
// Modelled on lists' expiry sweeper: hourly tick, per-org isolation, and
// withDb so a tenant pool cannot outlive the closure (CLAUDE.md section 8.1).

import { sql, type Kysely } from "kysely";
import { platform, parcelAudience } from "@cobblr/platform-contract";
import { arrivedEverywhere } from "@cobblr/platform-contract";

const TICK_MS = 60 * 60 * 1000; // hourly; the decision below is what makes it daily-ish
export const ARRIVAL_PASS = "purchases.arrival-sweep";
/** Days after the first unanswered ask before one final nudge. */
const NUDGE_AFTER_DAYS = 3;
/** Never a third ask. Someone who ignored two is not served by a third. */
const MAX_ASKS = 2;
/** How long after its date an unanswered order is still a live QUESTION rather
 *  than history. Past this and a first contact stays quiet. */
const STALE_AFTER_DAYS = 30;

export function startArrivalSweeper(): void {
  // The walk is the kernel's (platform().sweeps, #3036): this registers the
  // per-workspace visit and its cadence and owns no timer, so the pass shares
  // one walk and one connection budget with every other pass.
  platform().sweeps.register({
    name: ARRIVAL_PASS,
    everyMs: TICK_MS,
    module: "purchases",
    visit: ({ orgId, db, now }) => visitWorkspace(orgId, db, now, {}),
  });
  console.log(`[purchases] arrival sweeper registered — every ${TICK_MS / 60_000} min`);

  // A bridge push means the carrier already answered: re-check that number
  // NOW, off-cadence. The bell is trusted, the data is not — the state still
  // comes through the authenticated read path, forced past the is-it-due gate.
  // The re-check reaches the carrier, so it schedules itself: the bus runs
  // subscribers inline and the inbound route that rang the bell would
  // otherwise wait on a network round trip it does not need.
  platform().events.on("core-shipments.tracker.pushed", "purchases", async (payload: unknown) => {
    const p = payload as { orgId?: string; tracking_number?: string };
    if (!p.orgId || !p.tracking_number) return;
    const { orgId, tracking_number: number } = p;
    setImmediate(() => {
      arrivalTick({ orgId, number, force: true }).catch((err: unknown) => {
        console.error("[purchases] pushed tracker re-check failed:", (err as Error).message);
      });
    });
  });

  // A shipping EMAIL said where the parcel is (core-scan read it and wrote
  // the state onto this order through the orders PATCH). Nothing to fetch —
  // the state is already on the row — so this is the ask for ONE order, now,
  // rather than at the next hourly walk: the delivered card arrives with the
  // email, not an hour after it.
  platform().events.on("core-scan.shipment.observed", "purchases", async (payload: unknown) => {
    const p = payload as { orgId?: string; orderId?: string };
    if (!p.orgId || !p.orderId) return;
    const { orgId, orderId } = p;
    setImmediate(() => {
      arrivalTick({ orgId, orderId }).catch((err: unknown) => {
        console.error("[purchases] shipment-observed ask failed:", (err as Error).message);
      });
    });
  });
}

/** What we know about an order's ask history when deciding whether to ask. */
export interface AskState {
  /** The ETA the order carries NOW. */
  expectedArrival: string;
  /** The prior ask, if any. */
  prior: { expectedArrival: string; asks: number; lastAskedAt: Date; carrierState?: string | null } | null;
  /** What the carrier last said, when the order has a tracking number we can
   *  follow. Absent for the majority of orders, which is why every rule below
   *  still works without it. */
  carrierState?: string | null;
}

export type AskDecision = "ask" | "nudge" | "quiet";

/** Whether to ask about this order, pure so the nagging rules are testable
 *  without a database or a clock.
 *
 *  The rules, and the reason each exists:
 *
 *    never asked            -> ask.
 *    the date moved         -> ask. A reschedule is a NEW promise about a new
 *                              day, and the old question was about a day that
 *                              no longer means anything.
 *    asked once, 3d ago     -> nudge. A late parcel is usually late by a
 *                              little, so one follow-up covers the common case.
 *    asked once, recently   -> quiet. The sweep runs hourly; without this it
 *                              would ask on every tick.
 *    asked twice            -> quiet, forever. A third ask is the system
 *                              repeating itself at someone who has already
 *                              declined to answer twice. */
export function decideAsk(state: AskState, now: Date): AskDecision {
  const { prior, carrierState } = state;

  // A carrier that says the parcel landed does NOT close the order. Delivered
  // means it is on a doorstep; only a person can say they took it in and put
  // it where they meant to. What the carrier buys us is a better MOMENT to
  // ask than a date the receipt guessed at, so this overrides the quiet rules
  // rather than replacing the question.
  if (carrierState === "delivered" || carrierState === "out_for_delivery") {
    // Still only once per state. Without this the hourly tick would re-ask
    // every hour for as long as the parcel sits on the porch.
    if (prior?.carrierState === carrierState) return "quiet";
    return "ask";
  }

  // The most valuable thing the carrier tells us is when NOT to ask. An
  // estimate that has passed while the parcel is demonstrably still moving was
  // simply wrong, and asking produces a question the user cannot answer,
  // followed by a nudge they also cannot answer.
  if (carrierState === "in_transit" || carrierState === "pre_transit") return "quiet";

  if (!prior) {
    // Never asked, and long past due: this is history, not a question. Without
    // this, switching the sweep on asks about every order anybody ever left
    // open, all at once — and so does importing a year of old records later.
    // A month-late parcel nobody marked arrived was chased or written off long
    // before Cobblr noticed.
    const overdueDays = (now.getTime() - Date.parse(`${state.expectedArrival}T23:59:59`)) / 86_400_000;
    if (Number.isFinite(overdueDays) && overdueDays > STALE_AFTER_DAYS) return "quiet";
    return "ask";
  }

  // A moved date is a different question. Reset rather than inherit the count.
  if (prior.expectedArrival !== state.expectedArrival) return "ask";

  if (prior.asks >= MAX_ASKS) return "quiet";

  const daysSince = (now.getTime() - prior.lastAskedAt.getTime()) / 86_400_000;
  return daysSince >= NUDGE_AFTER_DAYS ? "nudge" : "quiet";
}

/** How the question reads. Kept next to the decision because the wording IS
 *  the feature: this is the entire user-facing surface of the sweep. */
export function askMessage(
  order: { vendor: string | null; orderNumber: string | null },
  decision: AskDecision,
  carrier?: { state?: string | null; detail?: string | null } | null,
): string {
  const what = order.vendor ?? (order.orderNumber ? `order ${order.orderNumber}` : "Your order");

  // When the carrier has said something specific, say it back. "FedEx says it
  // was left at the front door" is a different prompt from "was this due?" —
  // it tells the user where to look before they answer.
  if (carrier?.state === "delivered") {
    const detail = carrier.detail?.trim();
    return detail
      ? `${what} was delivered: ${detail}. Put it away?`
      : `${what} was delivered. Put it away?`;
  }
  if (carrier?.state === "out_for_delivery") {
    return `${what} was out for delivery today. Did it turn up?`;
  }

  return decision === "nudge"
    ? `${what} — still not marked arrived. Did it turn up?`
    : `${what} was due today. Did it turn up?`;
}

export interface DueRow {
  id: string;
  vendor: string | null;
  order_number: string | null;
  expected_arrival: string | null;
  tracking_number: string | null;
  tracking_added_by_user_id: string | null;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  eta_source: string | null;
  prior_expected: string | null;
  prior_asks: number | null;
  prior_last_asked: Date | null;
  prior_carrier_state: string | null;
}

/** Rebuild the ask history a decision needs from one swept row. Pure, so the
 *  ledger round-trip is testable without a database.
 *
 *  A ledger row EXISTS whenever `asks`/`last_asked_at` are present — both are
 *  NOT NULL columns, so their presence is the reliable "we asked before" signal.
 *  Its `expected_arrival` may be NULL for a carrier-driven ask on an order with
 *  no estimate (migration 0006), so keying "did we ask?" off a non-null DATE
 *  wrongly treated every null-ETA ledger row as no prior ask at all — which made
 *  a delivered parcel with no ETA re-ask on every hourly tick, forever. The row's
 *  presence, not its date, is what proves the prior ask. */
export function askStateFromRow(row: DueRow, today: string): AskState {
  const askedBefore = row.prior_asks != null && row.prior_last_asked != null;
  return {
    expectedArrival: row.expected_arrival ?? today,
    prior: askedBefore
      ? {
          expectedArrival: row.prior_expected ?? today,
          asks: row.prior_asks as number,
          lastAskedAt: new Date(row.prior_last_asked as Date),
          carrierState: row.prior_carrier_state,
        }
      : null,
    carrierState: row.shipment_state,
  };
}

/** One sweep. Exported so tests and a CLI can fire it deterministically. A
 *  forced re-check of one parcel (`number`, `force`) visits that workspace
 *  directly rather than through the pass's walk: it is not a walk, and the
 *  walk's lock may be held by the hourly round at that moment. */
export async function arrivalTick(
  opts: { orgId?: string; now?: Date; number?: string; orderId?: string; force?: boolean } = {},
): Promise<{ due: number; asked: number }> {
  const now = opts.now ?? new Date();
  if (opts.orgId && (opts.number || opts.orderId || opts.force)) {
    const orgId = opts.orgId;
    const r = await platform().tenants.withDb(orgId, (raw) => visitWorkspace(orgId, raw, now, opts));
    return r ?? { due: 0, asked: 0 };
  }
  const run = await platform().sweeps.run(ARRIVAL_PASS, { orgIds: opts.orgId ? [opts.orgId] : undefined, now });
  let due = 0;
  let asked = 0;
  for (const { result } of run.results) {
    const r = result as Partial<{ due: number; asked: number }> | void;
    due += r?.due ?? 0;
    asked += r?.asked ?? 0;
  }
  if (asked > 0) console.log(`[purchases] arrival sweep: ${due} due, asked about ${asked}`);
  return { due, asked };
}

/** One workspace, the pool already open: the pass's visit. `org` and `raw`
 *  keep their names so the body reads as it did when it was the loop's. */
async function visitWorkspace(
  orgId: string,
  raw: unknown,
  now: Date,
  opts: { number?: string; orderId?: string; force?: boolean },
): Promise<{ due: number; asked: number } | void> {
  const org = { id: orgId };
  // The parcels of orders that ship in more than one (#5351) are followed and
  // asked about one by one, before the orders themselves.
  const parcels = await visitShipments(orgId, raw as Kysely<unknown>, now, opts);
  let due = parcels.due;
  let asked = parcels.asked;
  {
    {
      {
        const tdb = raw as Kysely<unknown>;

        // Orders past their ETA that nothing has closed. The left join carries
        // the ask history so the decision needs no second round trip, and a
        // workspace with nothing due does one cheap indexed read and stops.
        const q = sql<DueRow>`
          select o.id::text                as id,
                 o.vendor                  as vendor,
                 o.order_number            as order_number,
                 o.expected_arrival::text  as expected_arrival,
                 o.tracking_number         as tracking_number,
                 o.tracking_added_by_user_id as tracking_added_by_user_id,
                 o.shipment_state          as shipment_state,
                 o.shipment_checked_at     as shipment_checked_at,
                 o.eta_source              as eta_source,
                 a.expected_arrival::text  as prior_expected,
                 a.asks                    as prior_asks,
                 a.last_asked_at           as prior_last_asked,
                 a.carrier_state           as prior_carrier_state
            from purchases_orders o
            left join purchases_arrival_asks a on a.order_id = o.id
           where o.arrived_at is null
             and o.status not in ('arrived', 'cancelled')
             and (
               -- past its estimate: the date-only question
               (o.expected_arrival is not null
                and o.expected_arrival <= ${arrivedEverywhere(now)}::date)
               -- or followable: worth checking before the date, which is the
               -- entire reason to have a tracking number
               or nullif(btrim(coalesce(o.tracking_number, '')), '') is not null
             )
        `.compile(tdb);

        let rows: DueRow[];
        try {
          rows = ((await tdb.executeQuery(q)) as { rows: DueRow[] }).rows;
        } catch (err) {
          // A workspace whose purchases migrations have not caught up yet.
          if ((err as Error).message.includes("does not exist")) return { due, asked };
          throw err;
        }
        if (rows.length === 0) return { due, asked };

        // Ask the carrier first, where there is one to ask. core-shipments owns
        // every judgement here — whether it is even due, how its date ranks
        // against the estimate this order already carries, and when to ask
        // again — and we store what it hands back. Reached through the action
        // seam, so purchases never imports it.
        for (const row of rows) {
          if (!row.tracking_number?.trim()) continue;
          // A pushed re-check is about ONE parcel; leave the rest on cadence.
          if (opts.number && row.tracking_number !== opts.number) continue;
          if (opts.orderId && row.id !== opts.orderId) continue;
          try {
            const res = (await platform().actions.invoke("core-shipments:track", {
              orgId: org.id,
              // A sweep has no user: it is the clock, and it says so.
              userId: null,
              event: {
                name: "purchases.arrival-sweep",
                payload: {},
                actor: { user_id: null, display_name: null, auth_method: "system" },
                timestamp: now.toISOString(),
                trigger_type: "schedule",
              },
              args: {
                number: row.tracking_number,
                currentEta: row.expected_arrival,
                currentEtaSource: row.eta_source ?? (row.expected_arrival ? "receipt" : "none"),
                lastState: row.shipment_state,
                lastCheckedAt: row.shipment_checked_at?.toISOString() ?? null,
                // When we first saw 'delivered' - the dispute window measures
                // from here. Without it the window never elapsed and a
                // delivered-but-unconfirmed parcel polled daily forever
                // (2026-08-25 audit; cadence.ts says the intent this defeats).
                deliveredAt:
                  row.shipment_state === "delivered" ? row.shipment_checked_at?.toISOString() ?? null : null,
                // Only the user's confirmation finishes a parcel. The sweep
                // only selects orders with arrived_at null, so anything it
                // sees is by definition unconfirmed -- said explicitly so the
                // capability never has to infer it.
                confirmed: false,
                // A push means the carrier already answered; skip the
                // is-it-due gate for this one read.
                ...(opts.force ? { force: true } : {}),
              },
            })) as {
              followed?: boolean;
              status?: { state?: string; description?: string };
              eta?: { date: string | null; source: string };
              nextPollAt?: string | null;
            } | null;

            if (!res?.followed || !res.status?.state) {
              // The ATTEMPT is what the cadence paces. Skipping the stamp kept
              // lastCheckedAt null for an unrecognised or failing number, so
              // it was "due" on every hourly tick forever (2026-08-25 audit).
              await tdb.executeQuery(
                sql`update purchases_orders set shipment_checked_at = ${now}, updated_at = now() where id = ${row.id}`.compile(tdb),
              );
              continue;
            }

            // Local copy, so the ask decision below sees this tick's answer.
            row.shipment_state = res.status.state;
            const eta = res.eta ?? null;
            if (eta?.date) row.expected_arrival = eta.date;

            await tdb.executeQuery(
              sql`
                update purchases_orders
                   set shipment_state        = ${res.status.state},
                       shipment_checked_at   = ${now},
                       shipment_next_poll_at = ${res.nextPollAt ? new Date(res.nextPollAt) : null},
                       expected_arrival      = coalesce(${eta?.date ?? null}::date, expected_arrival),
                       eta_source            = coalesce(${eta?.source ?? null}, eta_source),
                       updated_at            = now()
                 where id = ${row.id}
              `.compile(tdb),
            );
          // pass-catch: a carrier or bridge being down is not an arrival; the date-only rules still apply
          } catch (err) {
            // A carrier or bridge being down is not an arrival and not a
            // failure of the sweep: the date-only rules still apply below.
            console.warn(`[purchases] tracking check failed for order ${row.id}:`, (err as Error).message);
          }
        }

        // What is worth asking about. Two independent reasons, and the carrier
        // one must NOT be gated on the date: a parcel usually arrives before
        // its estimate, so requiring both meant a delivered parcel was never
        // asked about until its original ETA came round, which is the whole
        // thing tracking was supposed to improve.
        // NOT the UTC day: at 8pm US Eastern that is already tomorrow, so an
        // order due the 25th was asked about on the evening of the 24th
        // (2026-08-24). See arrivedEverywhere.
        const today = arrivedEverywhere(now);
        const askable = rows.filter(
          (r) =>
            // A shipment-observed ask is about ONE order, the one the email
            // named; the rest keep their own cadence.
            (!opts.orderId || r.id === opts.orderId) &&
            (r.shipment_state === "delivered" ||
              r.shipment_state === "out_for_delivery" ||
              (r.expected_arrival !== null && r.expected_arrival <= today)),
        );
        due += askable.length;

        const decisions = askable
          .map((r) => ({
            row: r,
            decision: decideAsk(askStateFromRow(r, today), now),
          }))
          .filter((d) => d.decision !== "quiet");
        if (decisions.length === 0) return { due, asked };

        // Only now, with something to say, do we pay for the member list.
        const memberIds = await platform().notifications.orgMemberIds(org.id);

        for (const { row, decision } of decisions) {
          // Null for a carrier-driven ask on an order with no estimate.
          const askedAbout = row.expected_arrival;
          const message = askMessage({ vendor: row.vendor, orderNumber: row.order_number }, decision, {
            state: row.shipment_state,
            detail: null,
          });
          // Stamp BEFORE dispatching. The old order ("stamp after, repeating
          // is the harmless direction") had the asymmetry backwards: for a
          // delivered parcel decideAsk answers "ask" unconditionally, so a
          // failed stamp meant the same question to every member on every
          // tick, forever, uncapped by MAX_ASKS (2026-08-25 audit). Claiming
          // first costs at most one lost ask, and the nudge tier re-asks.
          try {
            const up = sql`
              insert into purchases_arrival_asks (order_id, expected_arrival, asks, first_asked_at, last_asked_at, carrier_state)
              values (${row.id}, ${askedAbout}::date, 1, ${now}, ${now}, ${row.shipment_state})
              on conflict (order_id) do update set
                expected_arrival = excluded.expected_arrival,
                carrier_state = excluded.carrier_state,
                -- A moved date restarts the count; the same date increments it.
                -- IS NOT DISTINCT FROM, not =, so two null ETAs (a carrier-driven
                -- ask on an order with no estimate) count as the SAME question
                -- rather than NULL = NULL never being true and resetting to 1.
                asks = case when purchases_arrival_asks.expected_arrival is not distinct from excluded.expected_arrival
                            then purchases_arrival_asks.asks + 1 else 1 end,
                last_asked_at = excluded.last_asked_at
            `.compile(tdb);
            await tdb.executeQuery(up);
          } catch (err) {
            platform().health.notePassFailure("purchases.arrival-claim", orgId, err);
            // No claim, no send: sending anyway is how the unbounded re-ask
            // happened. This parcel gets asked about next tick instead.
            console.error("[purchases] arrival ledger write failed:", (err as Error).message);
            continue;
          }

          // The order's owner — whoever set its tracking number — or everyone
          // when no owner is known (orders never recorded a creator, so
          // legacy rows broadcast exactly as before).
          const audience = parcelAudience([row.tracking_added_by_user_id], new Set(memberIds));
          const recordLink = await platform().entities.recordAddressForEntity(
            org.id,
            "purchases:order",
            row.id,
          );
          for (const userId of audience) {
            try {
              await platform().notifications.dispatch({
                orgId: org.id,
                userId,
                eventType: "purchases.order.due",
                message,
                module: "purchases",
                // This sweeper IS the clock - its asks belong to the user's
                // digest window, not to whatever hour the tick ran.
                triggeredBy: "schedule",
                entityType: "purchases:order",
                entityId: row.id,
                // Without this the notification asks a question and gives no
                // way to answer it: dispatch does NOT derive a link from
                // entityType/entityId, it passes link_url straight through.
                ...(recordLink
                  ? { link_url: recordLink }
                  : { no_link_reason: "the order has no detail page" }),
                // The DM renders this as one rich card with the button in it,
                // instead of a sentence trailing a bare URL.
                card: {
                  heading: askedAbout
                    ? `An order was due ${askedAbout}`
                    : "An order should have arrived",
                  body: message,
                  ...(row.vendor ? { context: row.vendor } : {}),
                },
                payload: { expectedArrival: askedAbout, nudge: decision === "nudge" },
                // The answer to the question the message asks, offered in the
                // message. `mark-arrived` is idempotent, so pressing it twice
                // (two devices, a stale card) is harmless.
                //
                // Only here, and NOT on core-scan's parcel notification: that
                // one is about a receipt still in the inbox, which has no
                // order to mark. An action whose subject does not exist yet
                // returns "no order in scope" and looks like a dead button.
                actions: [
                  {
                    id: "arrived",
                    label: "Yes, it turned up",
                    action: "purchases:mark-arrived",
                    args: { orderId: row.id },
                    style: "primary" as const,
                  },
                ],
              });
            } catch (err) {
              platform().health.notePassFailure("purchases.arrival-notify", orgId, err);
              console.error("[purchases] arrival notify failed:", (err as Error).message);
            }
          }

          asked += 1;
        }
      }
    }
  }
  return { due, asked };
}

interface ParcelRow {
  id: string;
  order_id: string;
  tracking_number: string;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  expected_arrival: string | null;
  eta_source: string | null;
  asked_state: string | null;
  tracking_added_by_user_id: string | null;
  vendor: string | null;
  order_number: string | null;
  order_owner: string | null;
  lines: string[] | null;
}

/** What a parcel's card says: the store and the lines in the box. */
export function parcelMessage(p: { vendor: string | null; orderNumber: string | null; lines: readonly string[] }, state: string): string {
  const what = p.lines.length ? p.lines.join(", ") : "A parcel";
  const from = p.vendor ? ` from ${p.vendor}` : p.orderNumber ? ` (order ${p.orderNumber})` : "";
  return state === "delivered" ? `${what}${from} was delivered. Put it away?` : `${what}${from} is out for delivery today.`;
}

/** One order's parcels, each followed on its own number and asked about once
 *  per state, delivered or out for delivery. The order-level rules above
 *  still ask about the lines in no parcel. */
async function visitShipments(
  orgId: string,
  tdb: Kysely<unknown>,
  now: Date,
  opts: { number?: string; orderId?: string; force?: boolean },
): Promise<{ due: number; asked: number }> {
  let rows: ParcelRow[];
  try {
    rows = (
      await sql<ParcelRow>`
        select s.id::text as id, s.order_id::text as order_id, s.tracking_number, s.shipment_state,
               s.shipment_checked_at, s.expected_arrival::text as expected_arrival, s.eta_source, s.asked_state,
               s.tracking_added_by_user_id, o.vendor, o.order_number,
               o.tracking_added_by_user_id as order_owner,
               (select array_agg(coalesce(i.description, 'an item') order by i.created_at)
                  from purchases_order_items i where i.shipment_id = s.id) as lines
          from purchases_order_shipments s
          join purchases_orders o on o.id = s.order_id
         where o.arrived_at is null
           and o.status not in ('arrived', 'cancelled')
           and s.received_at is null
           and (not exists (select 1 from purchases_order_items i where i.shipment_id = s.id)
                or exists (select 1 from purchases_order_items i where i.shipment_id = s.id and i.received_at is null))
      `.execute(tdb)
    ).rows;
  } catch (err) {
    // A workspace whose purchases migrations have not caught up yet.
    if ((err as Error).message.includes("does not exist")) return { due: 0, asked: 0 };
    throw err;
  }
  if (rows.length === 0) return { due: 0, asked: 0 };

  for (const row of rows) {
    if (opts.number && row.tracking_number !== opts.number) continue;
    if (opts.orderId && row.order_id !== opts.orderId) continue;
    try {
      const res = (await platform().actions.invoke("core-shipments:track", {
        orgId,
        userId: null,
        event: {
          name: "purchases.arrival-sweep",
          payload: {},
          actor: { user_id: null, display_name: null, auth_method: "system" },
          timestamp: now.toISOString(),
          trigger_type: "schedule",
        },
        args: {
          number: row.tracking_number,
          currentEta: row.expected_arrival,
          currentEtaSource: row.eta_source ?? (row.expected_arrival ? "receipt" : "none"),
          lastState: row.shipment_state,
          lastCheckedAt: row.shipment_checked_at ? new Date(row.shipment_checked_at).toISOString() : null,
          deliveredAt: row.shipment_state === "delivered" && row.shipment_checked_at ? new Date(row.shipment_checked_at).toISOString() : null,
          confirmed: false,
          ...(opts.force ? { force: true } : {}),
        },
      })) as { followed?: boolean; status?: { state?: string }; eta?: { date: string | null; source: string }; nextPollAt?: string | null } | null;
      if (!res?.followed || !res.status?.state) {
        // The attempt is what the cadence paces, answered or not.
        await sql`update purchases_order_shipments set shipment_checked_at = ${now}, updated_at = now() where id = ${row.id}`.execute(tdb);
        continue;
      }
      row.shipment_state = res.status.state;
      await sql`
        update purchases_order_shipments
           set shipment_state        = ${res.status.state},
               shipment_checked_at   = ${now},
               shipment_next_poll_at = ${res.nextPollAt ? new Date(res.nextPollAt) : null},
               expected_arrival      = coalesce(${res.eta?.date ?? null}::date, expected_arrival),
               eta_source            = coalesce(${res.eta?.source ?? null}, eta_source),
               updated_at            = now()
         where id = ${row.id}
      `.execute(tdb);
    // pass-catch: a carrier being down is not an arrival; the parcel keeps its last state
    } catch (err) {
      platform().health.notePassFailure("purchases.parcel-track", orgId, err);
    }
  }

  const askable = rows.filter(
    (r) =>
      (!opts.orderId || r.order_id === opts.orderId) &&
      (r.shipment_state === "delivered" || r.shipment_state === "out_for_delivery") &&
      r.asked_state !== r.shipment_state,
  );
  if (askable.length === 0) return { due: 0, asked: 0 };
  const memberIds = new Set(await platform().notifications.orgMemberIds(orgId));
  let asked = 0;
  for (const parcel of askable) {
    // Claim before sending, the same order the order-level ask keeps: a
    // failed stamp costs one ask, never an ask on every tick.
    const claimed = await sql<{ id: string }>`
      update purchases_order_shipments set asked_state = ${parcel.shipment_state}, updated_at = now()
       where id = ${parcel.id} and asked_state is distinct from ${parcel.shipment_state}
      returning id::text as id
    `.execute(tdb).catch((err: unknown) => {
      platform().health.notePassFailure("purchases.parcel-claim", orgId, err);
      return { rows: [] as Array<{ id: string }> };
    });
    if (!claimed.rows.length) continue;
    const message = parcelMessage({ vendor: parcel.vendor, orderNumber: parcel.order_number, lines: parcel.lines ?? [] }, parcel.shipment_state!);
    const recordLink = await platform().entities.recordAddressForEntity(orgId, "purchases:order", parcel.order_id);
    const audience = parcelAudience([parcel.tracking_added_by_user_id ?? parcel.order_owner], memberIds);
    for (const userId of audience) {
      try {
        // dispatch-per-row-ok: one card per parcel; each box lands on its own day and carries its own "Yes, it turned up" for just its lines
        await platform().notifications.dispatch({
          orgId,
          userId,
          eventType: "purchases.order.due",
          message,
          module: "purchases",
          triggeredBy: "schedule",
          entityType: "purchases:order",
          entityId: parcel.order_id,
          ...(recordLink ? { link_url: recordLink } : { no_link_reason: "the order has no detail page" }),
          card: {
            heading: parcel.shipment_state === "delivered" ? "A parcel was delivered" : "A parcel is out for delivery",
            body: message,
            ...(parcel.vendor ? { context: `${parcel.vendor}${parcel.order_number ? ` · #${parcel.order_number}` : ""}` } : {}),
          },
          payload: { shipmentId: parcel.id, trackingNumber: parcel.tracking_number, state: parcel.shipment_state },
          actions: [
            {
              id: "arrived",
              label: "Yes, it turned up",
              action: "purchases:mark-arrived",
              args: { orderId: parcel.order_id, shipmentId: parcel.id },
              style: "primary" as const,
            },
          ],
        });
      } catch (err) {
        platform().health.notePassFailure("purchases.parcel-notify", orgId, err);
      }
    }
    asked += 1;
  }
  return { due: askable.length, asked };
}
