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

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { PurchasesDB } from "./db.js";

/** The day "Mark arrived" shipped: an arrival from this day on may have
 *  gone through it. */
export const MARK_ARRIVED_SHIPPED = "2026-08-13";


export const UNCONFIRMED_NOTICE = "purchases.receipts.unconfirmed";

/** Heal one workspace; answers how many lines it stamped. */
export async function healUnreceivedArrivalsIn(orgId: string, db: Kysely<PurchasesDB>): Promise<number> {
  const stamped = await sql<{ flagged: boolean }>`
    update purchases_order_items i
       set received_at = coalesce(o.arrived_at, o.ordered_at, i.created_at::date),
           receipt_unconfirmed = coalesce(o.arrived_at, i.created_at::date) >= ${MARK_ARRIVED_SHIPPED}::date
      from purchases_orders o
     where o.id = i.order_id
       and o.status = 'arrived'
       and i.part_id is not null
       and i.received_at is null
    returning i.receipt_unconfirmed as flagged`.execute(db);
  const flagged = stamped.rows.filter((r) => r.flagged).length;
  if (flagged > 0) {
    // Once: the lines are stamped now, so no later visit flags them again.
    const message =
      flagged === 1
        ? "One line on an order marked arrived may not have added its stock. Check it on the Purchases page."
        : `${flagged} lines on orders marked arrived may not have added their stock. Check them on the Purchases page.`;
    for (const userId of await platform().notifications.orgMemberIds(orgId)) {
      await platform()
        .notifications.dispatch({
          orgId,
          userId,
          eventType: UNCONFIRMED_NOTICE,
          message,
          module: "purchases",
          triggeredBy: "schedule",
          link_url: "/purchases?unconfirmed=1",
          card: { heading: "Some orders may not have added their stock", body: message },
        })
        .catch((err: unknown) => console.error("[purchases] unconfirmed-receipt notice failed:", (err as Error).message));
    }
  }
  return stamped.rows.length;
}

export function registerUnreceivedArrivalsHeal(): void {
  registerHealPass({
    name: "purchases.heal-unreceived-arrivals",
    shim: "modules/purchases/src/heal-unreceived-arrivals.ts",
    module: "purchases",
    visit: ({ orgId, db }) => healUnreceivedArrivalsIn(orgId, db as Kysely<PurchasesDB>),
  });
}
