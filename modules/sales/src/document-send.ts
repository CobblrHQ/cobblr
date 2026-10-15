import { z } from "zod";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { documentPdf } from "./document-pdf.js";
import { documentPayment } from "./documents.js";
import { documentText } from "./invoice.js";
import { orderHappened } from "./history.js";

export const SendDocument = z.object({ kind: z.enum(["quote", "invoice"]), version: z.string().uuid(), to: z.string().email() }).strict();
export class DocumentSendRefusal extends ActionRefusal {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function documentForSend(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: unknown, instance?: string) {
  if (!userId || !await platform().auth.userHasRole({ orgId, userId, minRole: "owner" })) throw new DocumentSendRefusal(403, "forbidden", "Only a workspace owner can email a quote or invoice.");
  const parsed = SendDocument.safeParse(input);
  if (!parsed.success) throw new DocumentSendRefusal(400, "bad_body", "Choose the saved quote or invoice, its revision and the customer's email address.");
  let q = db.selectFrom("sales_orders").selectAll().where("id", "=", orderId);
  if (instance !== undefined) q = q.where("instance", "=", instance);
  const order = await q.executeTakeFirst();
  if (!order) throw new DocumentSendRefusal(404, "not_found", "Order not found.");
  const doc = await db.selectFrom("sales_order_documents").selectAll().where("order_id", "=", order.id).where("instance", "=", order.instance).where("kind", "=", parsed.data.kind).executeTakeFirst();
  if (!doc) throw new DocumentSendRefusal(404, "not_found", "Prepare the document first.");
  if (doc.revision !== parsed.data.version) throw new DocumentSendRefusal(409, "document_changed", "The document changed. Read it again before sending.");
  const customer = order.customer_id ? await db.selectFrom("sales_customers").select("email").where("id", "=", order.customer_id).where("instance", "=", order.instance).executeTakeFirst() : null;
  if (!customer?.email) throw new DocumentSendRefusal(400, "no_email", "The linked customer has no email address.");
  if (customer.email !== parsed.data.to) throw new DocumentSendRefusal(409, "recipient_changed", "The customer's email changed. Check the recipient again before sending.");
  return { order, doc, to: customer.email, userId };
}
export async function sendDocument(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: unknown, instance?: string) {
  const { order, doc, to, userId: sender } = await documentForSend(db, orgId, userId, orderId, input, instance);
  const payment = await documentPayment(order, sender);
  const subject = `${doc.kind === "quote" ? "Quote" : "Invoice"} ${doc.number} from ${doc.snapshot.shop_name}`;
  const result = await platform().outboundEmail.send(orgId, {
    to, subject, text: documentText(doc.snapshot, payment), sentBy: sender, category: "sales_document",
    source: { kind: "sales:order", id: order.id },
    attachments: [{ filename: `${doc.kind}-${doc.id}.pdf`, contentType: "application/pdf", content: await documentPdf(doc.snapshot, payment) }],
  });
  if (result.logId) await orderHappened(db, orgId, order.id, { kind: "email", by_user: sender, detail: { document: doc.kind, number: doc.number, to, subject, log_id: result.logId, status: result.ok ? result.status : "failed" } });
  if (!result.ok) throw new DocumentSendRefusal(result.reason === "rate_limited" ? 429 : 409, result.reason, result.message);
  return { ok: true, to, status: result.status };
}
