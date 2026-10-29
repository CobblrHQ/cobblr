import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB } from "./db.js";
import { nextOrderNumber } from "./order-number.js";
import { addLine } from "./order-lines.js";
import { orderHappened } from "./history.js";

const text = z.string().trim().min(1).max(2000);
export const CreateOrder = z.object({
  instance: z.string().trim().min(1).max(200).default("sales"),
  order_number: text.optional(),
  status: z.enum(["draft", "confirmed"]).default("confirmed"),
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v))).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v))).optional(),
  shipping_address: z.string().max(4000).optional(),
  notes: z.string().max(10000).optional(),
  metadata: z.record(z.unknown()).optional(),
  source: z.object({ name: text, ref: text, url: z.string().url().max(4000).refine((v) => /^https?:\/\//.test(v)).optional() }).optional(),
  customer: z.object({ name: text.optional(), email: z.string().trim().toLowerCase().email().optional(), phone: z.string().max(200).optional(), address: z.string().max(4000).optional() }).optional(),
  items: z.array(z.object({ part_id: z.string().uuid().nullable().optional(), description: z.string().max(2000).nullable().optional(), qty: z.number().finite().positive(), unit_price: z.number().finite().nonnegative().nullable().optional(), metadata: z.record(z.unknown()).optional() })).min(1).max(200),
});
export type CreateOrderInput = z.infer<typeof CreateOrder>;

export async function createOrder(db: Kysely<SalesDB>, orgId: string, userId: string | null, raw: unknown) {
  const parsed = CreateOrder.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: `Cannot create order: ${parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}` };
  const a = parsed.data;
  const afterCommit: Array<() => Promise<void>> = [];
  const result = await db.transaction().execute(async (trx) => {
    // Serialize creates in an instance, including customer reuse and generated numbers.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`sales:create:${a.instance}`}, 0))`.execute(trx);
    if (a.source) {
      const old = await trx.selectFrom("sales_orders").select(["id", "customer_id"]).where("instance", "=", a.instance)
        .where("source_name", "=", a.source.name).where("source_ref", "=", a.source.ref).executeTakeFirst();
      if (old) return { ok: true as const, orderId: old.id, customerId: old.customer_id, duplicate: true };
    }
    let customerId: string | null = null;
    let customerName = a.customer?.name ?? null;
    if (a.customer?.email) {
      const old = await trx.selectFrom("sales_customers").select(["id", "name"]).where("instance", "=", a.instance)
        .where(sql<string>`lower(email)`, "=", a.customer.email).executeTakeFirst();
      if (old) { customerId = old.id; customerName = old.name; }
    }
    if (!customerId && a.customer && (a.customer.name || a.customer.email)) {
      const c = await trx.insertInto("sales_customers").values({ instance: a.instance, name: a.customer.name || a.customer.email!, email: a.customer.email ?? null, phone: a.customer.phone ?? null, address: a.customer.address ?? null, notes: null, metadata: {} }).returningAll().executeTakeFirstOrThrow();
      customerId = c.id; customerName = c.name;
      afterCommit.push(async () => {
        await platform().events.emit("sales.customer.created", { orgId, customerId: c.id, userId });
        await platform().activity.log({ orgId, userId, action: "customer_created", ref: { module: "sales", entityType: "customer", entityId: c.id }, diff: { name: c.name } });
      });
    }
    const order = await trx.insertInto("sales_orders").values({ instance: a.instance, customer_id: customerId, customer_name: customerName,
      order_number: a.order_number || await nextOrderNumber(trx, a.instance), status: a.status, order_date: a.order_date ?? await platform().accounts.dayFor(userId), due_date: a.due_date ?? null,
      shipping_address: a.shipping_address ?? null, notes: a.notes ?? null, metadata: a.metadata ?? {},
      source_name: a.source?.name ?? null, source_ref: a.source?.ref ?? null, source_url: a.source?.url ?? null,
    } as never).returningAll().executeTakeFirstOrThrow();
    await orderHappened(trx, orgId, order.id, { kind: "status", to_status: order.status, by_user: userId }, afterCommit);
    for (const line of a.items) await addLine(trx, orgId, userId, order.id, line, afterCommit);
    afterCommit.push(async () => {
      await platform().events.emit("sales.order.created", { orgId, orderId: order.id });
      await platform().activity.log({ orgId, userId, action: "order_created", ref: { module: "sales", entityType: "order", entityId: order.id }, diff: { name: customerName ?? order.order_number, source: a.source ?? null } });
    });
    return { ok: true as const, orderId: order.id, customerId, duplicate: false };
  });
  for (const publish of afterCommit) await publish();
  return result;
}
