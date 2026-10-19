import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { isLowStock, onHandCount, openUnitsFor } from "./on-hand.js";
import type { InventoryDB } from "./db.js";

export const LOW_STOCK_PASS = "inventory.low-stock-alerts";
export const LOW_STOCK_EVENT = "inventory.low-stock";

interface AlertDB {
  orgs: { id: string; low_stock_alerts: boolean };
}
export const alertMeta = () => platform().db.meta as Kysely<AlertDB>;

export function registerLowStockAlerts(): void {
  platform().sweeps.register({
    name: LOW_STOCK_PASS, module: "inventory", everyMs: 60 * 60 * 1000,
    candidates: async (ids) => ids.length ? (await alertMeta().selectFrom("orgs").select("id")
      .where("id", "in", ids).where("low_stock_alerts", "=", true).execute()).map((r) => r.id) : [],
    visit: ({ orgId, db, now }) => visitLowStock(orgId, db, now),
  });
}

interface StockRow {
  id: string; name: string; instance: string; qty: string; min_qty: string;
  assigned_qty: string; approximate_qty: string | null;
  metadata: Record<string, unknown>;
}

export async function visitLowStock(orgId: string, raw: unknown, now: Date): Promise<{ notified: number }> {
  const meta = alertMeta();
  const setting = await meta.selectFrom("orgs").select("low_stock_alerts").where("id", "=", orgId).executeTakeFirst();
  if (!setting?.low_stock_alerts) return { notified: 0 };
  const db = raw as Kysely<InventoryDB>;
  const result = await sql<StockRow>`
    select p.id, p.name, p.instance, p.qty, p.min_qty, p.approximate_qty, p.metadata,
      (select coalesce(sum(a.qty), 0) from inventory_allocations a
       where a.part_id = p.id and a.status = 'reserved') as assigned_qty
    from inventory_parts p
    where p.min_qty is not null and not p.archived and p.state = 'active'
    order by p.name, p.id
  `.execute(db);
  const openUnits = await openUnitsFor(db, result.rows.map((p) => p.id));
  const counted = result.rows.map((p) => ({ ...p, onHand: onHandCount(Number(p.qty), openUnits.get(p.id) ?? []) }));
  const items = counted.filter((p) => p.metadata?.low_stock_alerts_excluded !== true && isLowStock({
    onHand: p.onHand, assigned: Number(p.assigned_qty ?? 0),
    minQty: Number(p.min_qty), approximate: p.approximate_qty == null ? null : Number(p.approximate_qty),
  }));
  const shortages = await platform().notifications.digestContributions(LOW_STOCK_EVENT, orgId, raw);
  const count = items.length + shortages.length;
  if (!count) return { notified: 0 };
  const message = `Running low: ${count} ${count === 1 ? "item" : "items"}\n` + items.map((p) =>
    `${p.name}: ${p.onHand - Number(p.assigned_qty ?? 0)} left (minimum ${Number(p.min_qty)})`).concat(shortages.map(s => s.text)).join("\n");
  const sent = await sql<{ user_id: string; notified_on: string }>`
    select user_id, notified_on::text from low_stock_alert_deliveries where org_id = ${orgId}
  `.execute(meta);
  const ledger = new Map(sent.rows.map((r) => [r.user_id, r.notified_on]));
  const only = count === 1 && items.length === 1 ? items[0] : undefined;
  const link = shortages.length ? (shortages[0]?.link ?? "/") : only ? await platform().entities.recordAddressForEntity(orgId, "inventory:part", only.id) : "/";
  let notified = 0;
  for (const userId of await platform().notifications.audienceFor(orgId, LOW_STOCK_EVENT)) {
    const day = await platform().accounts.dayFor(userId, { now });
    if (ledger.get(userId) === day) continue;
    try {
      // dispatch-per-row-ok: one summary per recipient, never one send per item
      const delivery = await platform().notifications.dispatch({
        orgId, userId, eventType: LOW_STOCK_EVENT, module: "inventory",
        triggeredBy: "schedule", priority: "normal", message,
        subjectDay: day,
        subjects: [
          ...items.map((p) => ({ kind: "inventory:part", id: p.id, question: "low-stock", line: `${p.name}: ${p.onHand - Number(p.assigned_qty ?? 0)} left (minimum ${Number(p.min_qty)})` })),
          ...shortages.map((s) => ({ kind: "inventory:shortage", id: s.key, question: "low-stock", line: s.text })),
        ],
        link_url: link ?? "/", payload: { count },
      });
      if (!delivery.notificationId) continue;
      await sql`insert into low_stock_alert_deliveries (org_id, user_id, notified_on)
        values (${orgId}, ${userId}, ${day}::date)
        on conflict (org_id, user_id) do update set notified_on = excluded.notified_on`.execute(meta);
      notified++;
    } catch (err) {
      platform().health.notePassFailure("inventory.low-stock", orgId, err);
      console.error("[inventory] low-stock alert failed:", (err as Error).message);
    }
  }
  return { notified };
}
