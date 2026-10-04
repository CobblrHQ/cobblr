import { isCurrency } from "@cobblr/platform-contract/money";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ORDER_INTAKE, type IncomingOrder } from "@cobblr/platform-contract/order-intake";
import type { SalesDB } from "./db.js";
import { CreateOrder, type CreateOrderInput } from "./create-order.js";

export const IntakeConfig = z.object({ on: z.boolean(), connection: z.string().uuid(), mapping: z.record(z.string().uuid()).default({}) });
export interface IntakeSetting extends z.infer<typeof IntakeConfig> {
  by: string | null;
  cursor: string | null;
  job: string | null;
  run: string;
  error: string | null;
  checked_at: string | null;
  imported: number;
  duplicates: number;
}
const keyFor = (instance: string) => `order_intake:${instance}`;
export async function readIntake(db: Kysely<SalesDB>, instance: string): Promise<IntakeSetting | null> {
  const row = await db.selectFrom("sales_settings").select("value").where("key", "=", keyFor(instance)).executeTakeFirst();
  return row ? row.value as unknown as IntakeSetting : null;
}
export async function writeIntake(db: Kysely<SalesDB>, instance: string, setting: IntakeSetting) {
  const value = JSON.stringify(setting);
  await db.insertInto("sales_settings").values({ key: keyFor(instance), value }).onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: new Date() })).execute();
}
export async function configureIntake(db: Kysely<SalesDB>, orgId: string, instance: string, by: string, config: z.infer<typeof IntakeConfig>) {
  const connections = await platform().services.connectionsFor(orgId, ORDER_INTAKE);
  if (config.on && !connections.some((c) => c.credentialId === config.connection && c.shared)) throw new Error("Share this order connection with the workspace before turning intake on.");
  return db.transaction().execute(async (trx) => {
    await trx.selectFrom("sales_settings").select("key").where("key", "=", keyFor(instance)).forUpdate().execute();
    const old = await readIntake(trx, instance);
    const same = old?.connection === config.connection;
    if (old?.on && !same) throw new Error("Turn intake off before changing its connection.");
    const next: IntakeSetting = { ...config, by, cursor: same ? old.cursor : null, job: same ? old.job : null, run: same ? old.run : randomUUID(), error: null, checked_at: old?.checked_at ?? null, imported: old?.imported ?? 0, duplicates: old?.duplicates ?? 0 };
    await writeIntake(trx, instance, next);
    return next;
  });
}

export function mapIntakeOrder(order: IncomingOrder, mapping: Record<string, string>, fallbackCurrency?: string): CreateOrderInput {
  if (!order || !Array.isArray(order.items)) throw new Error("The service did not return an order with lines.");
  const currency = order.currency || fallbackCurrency;
  if (currency && !isCurrency(currency)) throw new Error("The order currency is invalid.");
  return CreateOrder.parse({ status: order.review ? "draft" : "confirmed", metadata: { ...(currency ? { currency } : {}), ...(order.review ? { order_email: order.review } : {}) }, source: { name: order.source, ref: order.ref, ...(order.url ? { url: order.url } : {}) }, order_number: order.number,
    order_date: order.date, shipping_address: order.shipping_address, notes: order.notes, customer: order.customer,
    items: order.items.map((line) => {
      const sku = line.sku?.trim();
      const part = sku ? mapping[sku] : null;
      if (sku && !part && !order.review) throw new Error(`Map SKU ${sku} to an inventory part before importing order ${order.ref}.`);
      return { part_id: part ?? null, description: line.description, qty: line.qty, unit_price: line.unit_price, metadata: { ...(sku ? { source_sku: sku } : {}), ...(currency ? { currency } : {}) } };
    }),
  });
}
export async function intakePage(orders: IncomingOrder[], mapping: Record<string, string>, invoke: (args: CreateOrderInput) => Promise<unknown>, fallbackCurrency?: string) {
  const mapped = orders.map((o) => mapIntakeOrder(o, mapping, fallbackCurrency));
  let imported = 0, duplicates = 0;
  for (const args of mapped) {
    const r = await invoke(args) as { ok?: boolean; error?: string; duplicate?: boolean } | null;
    if (!r?.ok) throw new Error(r?.error || "The order could not be saved.");
    if (r.duplicate) duplicates++; else imported++;
  }
  return { imported, duplicates };
}

export async function intakeRound(db: Kysely<SalesDB>, orgId: string, instance: string, retry = false) {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("sales_settings").select("value").where("key", "=", keyFor(instance)).forUpdate().executeTakeFirst();
    const s = row?.value as unknown as IntakeSetting | undefined;
    if (!s?.on || (s.error && !retry)) return s ?? null;
    try {
      const connections = await platform().services.connectionsFor(orgId, ORDER_INTAKE);
      if (!connections.some((c) => c.credentialId === s.connection && c.shared)) throw new Error("The order connection is no longer shared with this workspace. Reconnect it, then check again.");
      if (!s.job) {
        const ref = await platform().services.invoke({ orgId, capability: ORDER_INTAKE, via: { credentialId: s.connection }, input: { cursor: s.cursor, limit: 20 }, idempotencyKey: `sales-intake:${instance}:${s.run}` });
        s.job = ref.id;
      }
      const job = await platform().services.job(orgId, s.job);
      if (!job) { s.job = null; s.run = randomUUID(); throw new Error("The intake job is no longer available. Check again to read the source page."); }
      if (job.status === "failed" || job.status === "cancelled") {
        s.job = null; s.run = randomUUID();
        throw new Error(job.error?.message || "The order service could not read this page. Check its connection, then check again.");
      }
      if (job.status !== "done") { s.error = null; await writeIntake(trx, instance, s); return s; }
      const page = job.output as { orders?: IncomingOrder[]; cursor?: string | null } | null;
      if (!page || !Array.isArray(page.orders) || page.orders.length > 20 || !(typeof page.cursor === "string" || page.cursor === null)) throw new Error("The order service returned an invalid page.");
      const currency = await platform().money.currency(orgId);
      const counts = await intakePage(page.orders, s.mapping, async (args) => {
        for (const item of args.items) if (item.part_id && !await platform().entities.lookup(orgId, "inventory:part", item.part_id)) throw new Error(`The part mapped to ${String(item.metadata?.source_sku)} is no longer available. Choose another part.`);
        return platform().actions.invoke("sales:create-order", { orgId, userId: s.by, args: { ...args, instance }, event: { name: "sales.order-intake", payload: {}, timestamp: new Date().toISOString(), trigger_type: "schedule", actor: { user_id: s.by, display_name: null, auth_method: "system" } } });
      }, currency);
      s.cursor = page.cursor; s.job = null; s.run = randomUUID(); s.error = null; s.checked_at = new Date().toISOString();
      s.imported += counts.imported; s.duplicates += counts.duplicates;
    } catch (err) {
      if (err instanceof z.ZodError) { s.job = null; s.run = randomUUID(); }
      s.error = err instanceof z.ZodError ? `The order has invalid fields: ${err.issues.map((e) => e.path.join(".")).join(", ")}. Correct the source order and check again.` : err instanceof Error ? err.message : "Intake could not finish. Check the connection and try again.";
      s.checked_at = new Date().toISOString();
    }
    await writeIntake(trx, instance, s);
    return s;
  });
}
export function registerIntakeSweep() {
  platform().sweeps.register({ name: "sales.order-intake", module: "sales", everyMs: 60_000, visit: async ({ orgId, db }) => {
    const sales = db as Kysely<SalesDB>;
    const rows = await sales.selectFrom("sales_settings").select("key").where("key", "like", "order_intake:%").execute();
    for (const row of rows) await intakeRound(sales, orgId, row.key.slice("order_intake:".length));
  } });
}
