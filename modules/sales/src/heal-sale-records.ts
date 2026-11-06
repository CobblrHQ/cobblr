// One-shot heal: a customer has a name to read, and an order's paid flag says what its payments say.
//
// DONE WHEN: no sales_customers or sales_orders row made before `since` is changed by repairedCustomer, repairedCustomerName
// or settlePaidOrder. Check prod, staging and dev, then delete this file and its onBoot call.
//
// BORN WITH: customers.ts and orders.ts refuse a name with nothing to read, order-lines.ts settles the paid flag whenever a
// line changes, and a new order is never made paid, so a row made now is already right.
//
// WHY IT EXISTS: the API could save a customer named with only spaces, or across two lines, which drew a row with nothing to
// press. And a paid order that gained a line stayed paid, so the paid list and the accountant's file counted money still owed.
//
// An order marked paid with no payment at all is a different thing: somebody said it was paid (the create door took that, and
// migration 0015 skipped an order whose total was 0 then). It stays paid, and gets the payment it stands for, by 0015's rule.
// And payments covering an order that says it is not paid can't be somebody unticking it, as unticking undoes the payments:
// removing a line left the flag behind. A cancelled order is left, as nothing it holds is owed either way.

import { canBeAName } from "@cobblr/platform-contract/readable-text";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { orderHappened } from "./history.js";
import { withOrderLock } from "./order-lock.js";
import { syncPaid } from "./payments.js";
import { moneyOfOrders } from "./returns.js";

const oneLine = (text: string) => text.replace(/\p{Cc}+/gu, " ").trim();

/** An order's free-text customer: readable, or none. */
export function repairedCustomerName(name: string | null): string | null {
  if (name == null) return null;
  const line = oneLine(name);
  return canBeAName(line) ? line : null;
}

interface CustomerRow { name: string; email: string | null; phone: string | null }

/** What has to change on this customer, or null when nothing does. */
export function repairedCustomer(row: CustomerRow): Partial<CustomerRow> | null {
  const patch: Partial<CustomerRow> = {};
  const name = repairedCustomerName(row.name) ?? "Unnamed customer";
  if (name !== row.name) patch.name = name;
  if (row.email != null && !row.email.trim()) patch.email = null;
  if (row.phone != null && !row.phone.trim()) patch.phone = null;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Settle one paid order that reads as owing, under its lock, as a person may be paying it right now. True when it changed. */
async function settlePaidOrder(db: Kysely<SalesDB>, orgId: string, orderId: string, shop: string): Promise<boolean> {
  return withOrderLock(db, orgId, null, orderId, async () => {
    const order = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata", sql<string>`coalesce(paid_at, updated_at)::date::text`.as("paid_day")]).where("id", "=", orderId).executeTakeFirst();
    if (!order?.paid) return false;
    const money = (await moneyOfOrders(db, [order as never], shop)).get(orderId)!;
    if (!(money.owed > 0)) return false;
    const recorded = await db.selectFrom("sales_payments").select("id").where("order_id", "=", orderId).executeTakeFirst();
    if (recorded) {
      await db.updateTable("sales_orders").set({ paid: false } as never).where("id", "=", orderId).execute();
      return true;
    }
    await platform().activity.transaction(orgId, db, async (trx, log) => {
      const row = await trx.insertInto("sales_payments").values({ order_id: orderId, amount: money.gross, method: "other", paid_on: order.paid_day, created_by: null }).returning("id").executeTakeFirstOrThrow();
      await orderHappened(trx, orgId, orderId, { kind: "payment", detail: { payment_id: row.id, amount: money.gross, method: "other", paid_on: order.paid_day, recorded_from_paid_mark: true }, by_user: null }, [], log);
    });
    return true;
  });
}

export async function healSaleRecords(db: Kysely<SalesDB>, orgId: string, since: Date): Promise<number> {
  let healed = 0;
  for (const row of await db.selectFrom("sales_customers").select(["id", "name", "email", "phone"]).where("created_at", "<", since).execute()) {
    const patch = repairedCustomer(row);
    if (!patch) continue;
    await db.updateTable("sales_customers").set(patch).where("id", "=", row.id).execute();
    healed++;
  }
  for (const row of await db.selectFrom("sales_orders").select(["id", "customer_name"]).where("customer_name", "is not", null).where("created_at", "<", since).execute()) {
    const name = repairedCustomerName(row.customer_name);
    if (name === row.customer_name) continue;
    await db.updateTable("sales_orders").set({ customer_name: name } as never).where("id", "=", row.id).execute();
    healed++;
  }
  const paid = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata"]).where("paid", "=", true).where("created_at", "<", since).execute();
  if (paid.length) {
    const shop = await platform().money.currency(orgId);
    const money = await moneyOfOrders(db, paid as never, shop);
    for (const row of paid) {
      if (money.get(row.id)!.owed > 0 && (await settlePaidOrder(db, orgId, row.id, shop))) healed++;
    }
  }
  const unticked = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata"]).where("paid", "=", false).where("status", "!=", "cancelled").where("created_at", "<", since)
    .where(({ exists, selectFrom }) => exists(selectFrom("sales_payments").select("sales_payments.id").whereRef("sales_payments.order_id", "=", "sales_orders.id"))).execute();
  if (unticked.length) {
    const shop = await platform().money.currency(orgId);
    const money = await moneyOfOrders(db, unticked as never, shop);
    for (const row of unticked) {
      if (money.get(row.id)!.state !== "paid") continue;
      if (await withOrderLock(db, orgId, null, row.id, async () => (await syncPaid(db, row.id, shop))?.state === "paid")) healed++;
    }
  }
  return healed;
}

export function registerSaleRecordsHeal(): void {
  registerHealPass({
    name: "sales.sale-records",
    since: "2026-11-06T18:00:00Z",
    shim: "modules/sales/src/heal-sale-records.ts",
    module: "sales",
    visit: ({ db, orgId, since }) => healSaleRecords(db as Kysely<SalesDB>, orgId, since),
  });
}
