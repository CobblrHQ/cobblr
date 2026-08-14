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
import { platform } from "@cobblr/platform-contract";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // hourly; the decision below is what makes it daily-ish
/** Days after the first unanswered ask before one final nudge. */
const NUDGE_AFTER_DAYS = 3;
/** Never a third ask. Someone who ignored two is not served by a third. */
const MAX_ASKS = 2;

export function startArrivalSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 40_000); // after boot settles
  console.log(`[purchases] arrival sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await arrivalTick();
  } catch (err) {
    console.error("[purchases] arrival sweep failed:", (err as Error).stack ?? (err as Error).message);
  }
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

  if (!prior) return "ask";

  // A moved date is a different question. Reset rather than inherit the count.
  if (prior.expectedArrival !== state.expectedArrival) return "ask";

  if (prior.asks >= MAX_ASKS) return "quiet";

  const daysSince = (now.getTime() - prior.lastAskedAt.getTime()) / 86_400_000;
  return daysSince >= NUDGE_AFTER_DAYS ? "nudge" : "quiet";
}

/** Where the question takes you. A bare workspace-relative path, per the
 *  deep-link convention.
 *
 *  This MUST agree with `purchases:order`'s `detailRoute` in the manifest.
 *  There is no runtime seam to resolve a kind's detail route from a module, so
 *  the two are written twice and `arrival-sweep.mjs` asserts the link resolves
 *  to a real order rather than trusting they stayed in step. */
export function orderLink(orderId: string): string {
  return `/purchases/${orderId}`;
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

interface DueRow {
  id: string;
  vendor: string | null;
  order_number: string | null;
  expected_arrival: string | null;
  tracking_number: string | null;
  shipment_state: string | null;
  shipment_checked_at: Date | null;
  eta_source: string | null;
  prior_expected: string | null;
  prior_asks: number | null;
  prior_last_asked: Date | null;
  prior_carrier_state: string | null;
}

/** One sweep. Exported so tests and a CLI can fire it deterministically. */
export async function arrivalTick(opts: { orgId?: string; now?: Date } = {}): Promise<{ due: number; asked: number }> {
  const now = opts.now ?? new Date();
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;

  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) =>
      j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "purchases"),
    )
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);

  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch (err) {
    console.warn("[purchases] arrival sweep skipped — meta read failed:", (err as Error).message);
    return { due: 0, asked: 0 };
  }

  let due = 0;
  let asked = 0;

  for (const org of orgs) {
    try {
      await platform().tenants.withDb(org.id, async (raw) => {
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
                and o.expected_arrival <= ${now.toISOString().slice(0, 10)}::date)
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
          if ((err as Error).message.includes("does not exist")) return;
          throw err;
        }
        if (rows.length === 0) return;

        // Ask the carrier first, where there is one to ask. core-shipments owns
        // every judgement here — whether it is even due, how its date ranks
        // against the estimate this order already carries, and when to ask
        // again — and we store what it hands back. Reached through the action
        // seam, so purchases never imports it.
        for (const row of rows) {
          if (!row.tracking_number?.trim()) continue;
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
                // Only the user's confirmation finishes a parcel. The sweep
                // only selects orders with arrived_at null, so anything it
                // sees is by definition unconfirmed -- said explicitly so the
                // capability never has to infer it.
                confirmed: false,
              },
            })) as {
              followed?: boolean;
              status?: { state?: string; description?: string };
              eta?: { date: string | null; source: string };
              nextPollAt?: string | null;
            } | null;

            if (!res?.followed || !res.status?.state) continue;

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
        const today = now.toISOString().slice(0, 10);
        const askable = rows.filter(
          (r) =>
            r.shipment_state === "delivered" ||
            r.shipment_state === "out_for_delivery" ||
            (r.expected_arrival !== null && r.expected_arrival <= today),
        );
        due += askable.length;

        const decisions = askable
          .map((r) => ({
            row: r,
            decision: decideAsk(
              {
                expectedArrival: r.expected_arrival ?? today,
                prior:
                  r.prior_expected && r.prior_asks != null && r.prior_last_asked
                    ? {
                        expectedArrival: r.prior_expected,
                        asks: r.prior_asks,
                        lastAskedAt: new Date(r.prior_last_asked),
                        carrierState: r.prior_carrier_state,
                      }
                    : null,
                carrierState: r.shipment_state,
              },
              now,
            ),
          }))
          .filter((d) => d.decision !== "quiet");
        if (decisions.length === 0) return;

        // Only now, with something to say, do we pay for the member list.
        const memberIds = await platform().notifications.orgMemberIds(org.id);

        for (const { row, decision } of decisions) {
          // Null for a carrier-driven ask on an order with no estimate.
          const askedAbout = row.expected_arrival;
          const message = askMessage({ vendor: row.vendor, orderNumber: row.order_number }, decision, {
            state: row.shipment_state,
            detail: null,
          });
          for (const userId of memberIds) {
            try {
              await platform().notifications.dispatch({
                orgId: org.id,
                userId,
                eventType: "purchases.order.due",
                message,
                module: "purchases",
                entityType: "purchases:order",
                entityId: row.id,
                // Without this the notification asks a question and gives no
                // way to answer it: dispatch does NOT derive a link from
                // entityType/entityId, it passes link_url straight through.
                link_url: orderLink(row.id),
                payload: { expectedArrival: askedAbout, nudge: decision === "nudge" },
              });
            } catch (err) {
              console.error("[purchases] arrival notify failed:", (err as Error).message);
            }
          }

          // Stamp AFTER dispatching. Stamping first would lose the question
          // entirely if dispatch threw; stamping after can at worst repeat it
          // on the next tick, which is the harmless direction to fail in.
          try {
            const up = sql`
              insert into purchases_arrival_asks (order_id, expected_arrival, asks, first_asked_at, last_asked_at, carrier_state)
              values (${row.id}, ${askedAbout}::date, 1, ${now}, ${now}, ${row.shipment_state})
              on conflict (order_id) do update set
                expected_arrival = excluded.expected_arrival,
                carrier_state = excluded.carrier_state,
                -- A moved date restarts the count; the same date increments it.
                asks = case when purchases_arrival_asks.expected_arrival = excluded.expected_arrival
                            then purchases_arrival_asks.asks + 1 else 1 end,
                last_asked_at = excluded.last_asked_at
            `.compile(tdb);
            await tdb.executeQuery(up);
          } catch (err) {
            console.error("[purchases] arrival ledger write failed:", (err as Error).message);
          }
          asked += 1;
        }
      });
    } catch (err) {
      // Per-org isolation: one broken tenant never stops the rest.
      console.warn(`[purchases] arrival sweep skipped org ${org.id}:`, (err as Error).message);
    }
  }

  if (asked > 0) console.log(`[purchases] arrival sweep: ${due} due, asked about ${asked}`);
  return { due, asked };
}
