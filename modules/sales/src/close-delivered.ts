// DONE WHEN: every sales-enabled workspace has close_delivered_orders in sales_settings on prod, staging and dev; the heal count is zero.
// BORN WITH: migration 0007_close_delivered_orders.sql on signup or enable.
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { SalesDB } from "./db.js";
import { orderHappened } from "./history.js";

const SETTING = "close_delivered_orders";

export async function ensureDeliveryCloseDefault(db: Kysely<SalesDB>): Promise<number> {
  const rows = await db.insertInto("sales_settings").values({ key: SETTING, value: JSON.stringify({ on: true }) })
    .onConflict((oc) => oc.column("key").doNothing()).returning("key").execute();
  return rows.length;
}

export async function readDeliveryCloseSetting(db: Kysely<SalesDB>): Promise<boolean> {
  const row = await db.selectFrom("sales_settings").select("value").where("key", "=", SETTING).executeTakeFirst();
  return row?.value?.on !== false;
}

export async function setDeliveryCloseSetting(db: Kysely<SalesDB>, orgId: string, userId: string | null, on: boolean): Promise<void> {
  const value = JSON.stringify({ on });
  await db.insertInto("sales_settings").values({ key: SETTING, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: new Date() })).execute();
  await platform().activity.log({ orgId, userId, action: "delivery_close_setting_changed", ref: { module: "sales", entityType: "settings", entityId: SETTING }, diff: { on } });
}

export function deliveryCanClose(
  order: { status: string; paid: boolean; delivered_at: unknown; fulfilled_at: unknown; auto_close_undone: boolean },
  lines: Array<{ part_id: string | null; qty: string | number; qty_fulfilled: string | number }>,
): boolean {
  return order.status === "shipped" && order.paid === true && !!order.delivered_at && !!order.fulfilled_at && !order.auto_close_undone
    && lines.length > 0 && lines.every((l) => !l.part_id || Number(l.qty_fulfilled) >= Number(l.qty));
}

export async function closeDeliveredOrder(db: Kysely<SalesDB>, orgId: string, orderId: string): Promise<boolean> {
  if (!(await readDeliveryCloseSetting(db))) return false;
  const afterCommit: Array<() => Promise<void>> = [];
  const closed = await db.transaction().execute(async (trx) => {
    const order = await trx.selectFrom("sales_orders").selectAll().where("id", "=", orderId).forUpdate().executeTakeFirst();
    if (!order) return null;
    const lines = await trx.selectFrom("sales_order_items").select(["part_id", "qty", "qty_fulfilled"]).where("order_id", "=", orderId).execute();
    if (!deliveryCanClose(order, lines)) return null;
    // Recheck stock lines in the write: another door can edit them after the read.
    const row = await trx.updateTable("sales_orders").set({ status: "closed", auto_closed_at: new Date(), updated_at: new Date() })
      .where("id", "=", orderId).where("status", "=", "shipped").where("paid", "=", true).where("auto_close_undone", "=", false)
      .where(sql<boolean>`not exists (select 1 from sales_order_items where order_id = ${orderId} and part_id is not null and qty_fulfilled < qty)`)
      .returningAll().executeTakeFirst();
    if (!row) return null;
    await orderHappened(trx, orgId, orderId, { kind: "status", from_status: "shipped", to_status: "closed", detail: { automatic: "delivery" }, by_user: null }, afterCommit);
    return row;
  });
  if (!closed) return false;
  for (const publish of afterCommit) await publish();
  const link = await platform().entities.recordAddressForEntity(orgId, "sales:order", orderId);
  for (const userId of await platform().notifications.audienceFor(orgId, "sales.order.closed")) {
    // dispatch-per-row-ok: the loop addresses members with the same order notice; userId only varies the address and deduplication key.
    await platform().notifications.dispatch({ orgId, userId, eventType: "sales.order.closed", module: "sales", entityType: "order", entityId: orderId,
      idempotencyKey: `sales-delivery-close:${orderId}:${closed.auto_closed_at!.toISOString()}:${userId}`,
      message: `${closed.order_number || "Order"} was delivered and closed. It is paid and fully fulfilled.`,
      ...(link ? { link_url: link } : { no_link_reason: "The order has no registered page." }),
      actions: [{ id: "undo", label: "Undo", action: "sales:undo-delivery-close", args: { order_id: orderId } }],
    });
  }
  return true;
}

export async function undoDeliveryClose(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string): Promise<boolean> {
  const row = await db.updateTable("sales_orders").set({ status: "shipped", auto_closed_at: null, auto_close_undone: true, updated_at: new Date() })
    .where("id", "=", orderId).where("status", "=", "closed").where("auto_closed_at", "is not", null).returningAll().executeTakeFirst();
  if (!row) return false;
  await orderHappened(db, orgId, orderId, { kind: "status", from_status: "closed", to_status: "shipped", detail: { automatic_close_undone: true }, by_user: userId });
  return true;
}

export function registerDeliveryCloseHeal(): void {
  registerHealPass({ name: "sales.heal-delivery-close-default", shim: "modules/sales/src/close-delivered.ts", module: "sales",
    visit: async ({ db }) => ensureDeliveryCloseDefault(db as Kysely<SalesDB>),
  });
}
