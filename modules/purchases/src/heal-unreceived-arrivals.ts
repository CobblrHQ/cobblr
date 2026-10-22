// One-shot heal: past arrived orders whose lines were never marked received
// (#4115).
//
// DONE WHEN: no tenant DB has a purchases_order_items row with part_id set
// and received_at null on an order whose status is 'arrived', and none with
// receipt_unconfirmed = true. Check with, per tenant:
//   select count(*) from purchases_order_items i join purchases_orders o on o.id = i.order_id
//    where o.status = 'arrived' and i.part_id is not null and i.received_at is null;
//   select count(*) from purchases_order_items where receipt_unconfirmed;
// When both are 0 on prod, staging and app, delete this file and its boot
// call. Nothing makes new ones: receiveOrderLines (receive.ts) stamps every
// line it receives, and every door that adds a line to an order that has
// already arrived receives it there and then (receiveIfArrived).
//
// BORN WITH: nothing (a fresh workspace has no past arrivals to heal).
//
// WHY IT EXISTS: two doors said an order arrived. The status dropdown added
// the stock; "Mark arrived" (the order's button, the "did it turn up?"
// sweeper, the parcel tracker), shipped 2026-08-13, sent the wrong key and
// added nothing. Neither stamped the line received. So a past arrived line is
// one of three, and purchases cannot tell which: stock added (the dropdown),
// stock never added (Mark arrived), or an order logged already arrived from a
// receipt. Stock is never changed silently. Every such line is stamped
// received now, so it can never add its stock twice; the ones that arrived
// since Mark arrived shipped are also flagged, and the workspace is told once:
// a person settles each ("Add to stock", "Already counted") on the Purchases
// page. Lines that arrived before that date only ever had the dropdown, which
// added their stock, so they are stamped and not asked about.
//
// WHO IS NEVER ASKED (#4381): an order filed already arrived from a receipt
// (bought over a counter, carried home, filed from the scan inbox) never went
// through "Mark arrived": its lines' stock came from the scan filing each one.
// Nor is an order filed as a past purchase whose stock was already counted
// (add_to_stock off). Lines flagged before this rule are withdrawn on the next
// visit, so the question disappears without anyone answering it.

//
// DATE IS HISTORY: MARK_ARRIVED_SHIPPED is the day "Mark arrived" shipped. An
// arrival on or after it may have gone through it, which decides whether a line
// is asked about; the rows a visit takes are still those made before its since.
import { sql, type Kysely } from "kysely";
import { platform, countOf } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { PurchasesDB } from "./db.js";

/** The day "Mark arrived" shipped: an arrival from this day on may have
 *  gone through it. */
export const MARK_ARRIVED_SHIPPED = "2026-08-13";

// An arrival exposes its status before receive.ts stamps its lines. A heal
// claiming that gap would suppress the stock write. Only touch rows settled
// before this boot; a historical row edited now can wait for the next boot.
const BEFORE_BOOT = new Date(performance.timeOrigin);

export const UNCONFIRMED_NOTICE = "purchases.receipts.unconfirmed";

/** Could this order's arrival have gone through the old "Mark arrived"? Not
 *  when it was filed already arrived from a receipt (its arrival day is no
 *  later than the day it was filed), and never when it was not meant to add
 *  stock. `o` is purchases_orders. */
const MAY_HAVE_MISSED_STOCK = sql<boolean>`(
  coalesce(o.add_to_stock, true)
  and not (coalesce(o.metadata->>'source', '') = 'receipt' and coalesce(o.arrived_at, o.created_at::date) <= o.created_at::date)
)`;

/** What the notice and the banner say, in the person's words. */
export function unconfirmedSentence(n: number): string {
  return n === 1
    ? "One thing you ordered may not have reached your stock when it was delivered."
    : `${countOf(n, "thing")} you ordered may not have reached your stock when they were delivered.`;
}

/** Heal one workspace; answers how many lines it stamped or withdrew. */
export async function healUnreceivedArrivalsIn(orgId: string, db: Kysely<PurchasesDB>, since: Date): Promise<number> {
  // A question asked in error, before the rule above, is taken back.
  const withdrawn = await sql`
    update purchases_order_items i
       set receipt_unconfirmed = false
      from purchases_orders o
     where o.id = i.order_id
       and i.receipt_unconfirmed
       and i.created_at < ${since}
       and not ${MAY_HAVE_MISSED_STOCK}`.execute(db);
  const stamped = await sql<{ flagged: boolean }>`
    update purchases_order_items i
       set received_at = coalesce(o.arrived_at, o.ordered_at, i.created_at::date),
           receipt_unconfirmed = coalesce(o.arrived_at, i.created_at::date) >= ${MARK_ARRIVED_SHIPPED}::date and ${MAY_HAVE_MISSED_STOCK}
      from purchases_orders o
     where o.id = i.order_id
       and o.status = 'arrived'
       and i.part_id is not null
       and i.received_at is null
       and i.created_at < ${since}
       and o.updated_at < ${BEFORE_BOOT}
       and i.updated_at < ${BEFORE_BOOT}
    returning i.receipt_unconfirmed as flagged`.execute(db);
  const flagged = stamped.rows.filter((r) => r.flagged).length;
  if (flagged > 0) {
    // Once: the lines are stamped now, so no later visit flags them again.
    const message = unconfirmedSentence(flagged);
    for (const userId of await platform().notifications.orgMemberIds(orgId)) {
      await platform()
        .notifications.dispatch({
          orgId,
          userId,
          eventType: UNCONFIRMED_NOTICE,
          message,
          module: "purchases",
          triggeredBy: "schedule",
          subjects: [{ kind: "platform:workspace", id: orgId, question: "unconfirmed-receipts", line: message }],
          link_url: "/purchases?unconfirmed=1",
          card: { heading: "Check what was delivered", body: message },
        })
        .catch((err: unknown) => console.error("[purchases] unconfirmed-receipt notice failed:", (err as Error).message));
    }
  }
  return stamped.rows.length + Number(withdrawn.numAffectedRows ?? 0);
}

export function registerUnreceivedArrivalsHeal(): void {
  registerHealPass({
    name: "purchases.heal-unreceived-arrivals",
    since: "2026-09-30T23:24:49Z",
    shim: "modules/purchases/src/heal-unreceived-arrivals.ts",
    module: "purchases",
    visit: ({ orgId, db, since }) => healUnreceivedArrivalsIn(orgId, db as Kysely<PurchasesDB>, since),
  });
}
