import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { salesDocument, type SalesDocument, type DocumentPayment } from "./invoice.js";
import type { SalesDB } from "./db.js";
import { documentPdf } from "./document-pdf.js";
import { orderAvailability } from "./availability.js";

const day = z.string().date();
export const PrepareDocument = z.object({
  kind: z.enum(["quote", "invoice"]),
  shop_name: z.string().trim().min(1).max(200),
  deadline: day.nullable().default(null),
  tax_rate: z.number().min(0).max(100).default(0),
  logo_file_id: z.string().uuid().nullable().default(null),
}).strict();
export type PrepareDocumentInput = z.input<typeof PrepareDocument>;

export async function prepareDocument(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, raw: unknown, instance?: string) {
  const input = PrepareDocument.parse(raw);
  const currency = await platform().money.currency(orgId);
  const result = await db.transaction().execute(async trx => {
    let query = trx.selectFrom("sales_orders").selectAll().where("id", "=", orderId);
    if (instance) query = query.where("instance", "=", instance);
    const order = await query.forUpdate().executeTakeFirst();
    if (!order) throw new Error("That order is not here any more.");
    const existing = await trx.selectFrom("sales_order_documents").selectAll().where("order_id", "=", order.id).where("kind", "=", input.kind).executeTakeFirst();
    if (existing && input.kind === "invoice") return { document: existing, reused: true };
    const date = await platform().accounts.dayFor(userId);
    if (input.deadline && input.deadline < date) throw new Error("Choose a date today or later.");
    const items = await trx.selectFrom("sales_order_items").selectAll().where("order_id", "=", order.id).orderBy("created_at").orderBy("id").execute();
    const customer = order.customer_id ? await trx.selectFrom("sales_customers").selectAll().where("id", "=", order.customer_id).where("instance", "=", order.instance).executeTakeFirst() : null;
    const availability = await orderAvailability(orgId, items.map(it => ({ ...it, qty: Number(it.qty), qty_fulfilled: Number(it.qty_fulfilled) })), []);
    let logo: SalesDocument["logo"] = existing?.snapshot.logo ?? null;
    if (input.logo_file_id) {
      const file = await platform().files.read(orgId, input.logo_file_id, "original");
      if (!file || !["image/png", "image/jpeg"].includes(file.mimeType) || file.bytes.length > 1_000_000) throw new Error("Choose a PNG or JPEG logo smaller than 1 MB from this workspace.");
      logo = { mime: file.mimeType as "image/png" | "image/jpeg", base64: Buffer.from(file.bytes).toString("base64") };
    }
    const snapshot = salesDocument({ ...order, items, availability }, currency, { ...input, number: "", date, logo, customer_address: customer?.address ?? null });
    await documentPdf(snapshot);
    if (existing) snapshot.number = existing.number;
    else {
      const counter = await trx.insertInto("sales_document_counters").values({ instance: order.instance, kind: input.kind, last_number: 1 })
        .onConflict(oc => oc.columns(["instance", "kind"]).doUpdateSet({ last_number: sql` sales_document_counters.last_number + 1` })).returning("last_number").executeTakeFirstOrThrow();
      snapshot.number = `${input.kind === "invoice" ? "INV" : "Q"}-${String(counter.last_number).padStart(4, "0")}`;
    }
    const values = { order_id: order.id, instance: order.instance, kind: input.kind, number: snapshot.number, snapshot: JSON.stringify(snapshot) };
    const document = await trx.insertInto("sales_order_documents").values(values)
      .onConflict(oc => oc.columns(["order_id", "kind"]).doUpdateSet({ snapshot: values.snapshot, revision: sql`gen_random_uuid()`, created_at: new Date() }))
      .returningAll().executeTakeFirstOrThrow();
    return { document, reused: false };
  });
  if (!result.reused) await platform().activity.log({ orgId, userId, action: "order_document_prepared", ref: { module: "sales", entityType: "order", entityId: orderId }, diff: { kind: input.kind, number: result.document.number } });
  return result;
}

export async function documentPayment(order: { paid: boolean; paid_at: Date | null }, userId: string | null): Promise<DocumentPayment> {
  return { paid: order.paid, paid_on: order.paid && order.paid_at ? await platform().accounts.dayFor(userId, { now: order.paid_at }) : null };
}
