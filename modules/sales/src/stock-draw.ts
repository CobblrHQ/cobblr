import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { orderHappened } from "./history.js";
import type { SalesDB } from "./db.js";

type Draw = Selectable<SalesDB["sales_stock_draws"]>;

async function finishDraw(db: Kysely<SalesDB>, orgId: string, userId: string | null, draw: Draw): Promise<number> {
  const res = await platform().actions.invoke("inventory:adjust-stock", {
    orgId, userId, entity: { kind: "inventory:part", id: draw.part_id },
    event: {
      name: "sales.order.fulfilled", payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" },
      timestamp: new Date().toISOString(), trigger_type: "event",
    },
    args: { partId: draw.part_id, delta: -Number(draw.qty), operationKey: draw.id, reason: `sale:${draw.order_id}`, sourceKind: "sales:order", sourceId: draw.order_id },
  }) as { ok?: boolean; delta?: number } | null;
  const moved = res?.ok ? Math.abs(Number(res.delta ?? 0)) : 0;
  const afterCommit: Array<() => Promise<void>> = [];
  await db.transaction().execute(async trx => {
    await trx.updateTable("sales_order_items")
      .set({ qty_fulfilled: String(Number(draw.qty_before) + moved), updated_at: new Date() })
      .where("id", "=", draw.line_id).where("order_id", "=", draw.order_id).execute();
    await trx.updateTable("sales_stock_draws").set({ completed: true }).where("id", "=", draw.id).execute();
    if (moved > 0) await orderHappened(trx, orgId, draw.order_id, {
      kind: "stock", detail: { taken: [{ part_id: draw.part_id, qty: moved }] }, by_user: userId,
    }, afterCommit);
  });
  for (const publish of afterCommit) await publish();
  return moved;
}

export async function recoverStockDraws(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string): Promise<void> {
  const pending = await db.selectFrom("sales_stock_draws").selectAll().where("order_id", "=", orderId).where("completed", "=", false).execute();
  for (const draw of pending) await finishDraw(db, orgId, userId, draw);
}

export async function drawStock(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, line: { id: string; part_id: string; qty_fulfilled: number }, qty: number): Promise<number> {
  const draw: Draw = { id: randomUUID(), order_id: orderId, line_id: line.id, part_id: line.part_id, qty_before: String(line.qty_fulfilled), qty: String(qty), completed: false };
  // Persist the key before crossing the module boundary. A lost response or a
  // failed sales write replays this receipt rather than drawing stock again.
  await db.insertInto("sales_stock_draws").values(draw).execute();
  return finishDraw(db, orgId, userId, draw);
}
