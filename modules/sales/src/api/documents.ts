import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { PrepareDocument, prepareDocument, documentPayment } from "../documents.js";
import { documentPdf } from "../document-pdf.js";
import { DocumentSendRefusal, sendDocument } from "../document-send.js";
import { asyncHandler, badBody } from "./util.js";

export const documentsRouter = Router({ mergeParams: true });
const Kind = z.enum(["quote", "invoice"]);

async function orderHere(req: import("express").Request) {
  return tenantDb(req).selectFrom("sales_orders").selectAll().where("id", "=", req.params.id!).where("instance", "=", instanceOf(req)).executeTakeFirst();
}

documentsRouter.get("/", asyncHandler(async (req, res) => {
  const order = await orderHere(req);
  if (!order) { res.status(404).json({ error: { code: "not_found", message: "Order not found." } }); return; }
  const db = tenantDb(req);
  const items = await db.selectFrom("sales_order_documents").selectAll().where("order_id", "=", order.id).execute();
  const customer = order.customer_id ? await db.selectFrom("sales_customers").select("email").where("id", "=", order.customer_id).where("instance", "=", order.instance).executeTakeFirst() : null;
  const owner = tenantContext(req).role === "owner";
  const sender = owner ? await platform().outboundEmail.status(tenantContext(req).org.id) : { configured: false, from: null };
  res.json({ items, shop_name: tenantContext(req).org.name, email: { to: customer?.email ?? null, from: sender.from, available: owner && sender.configured && !!customer?.email,
    reason: !owner ? "Only a workspace owner can email a quote or invoice." : !sender.configured ? "Set up outbound email in Configuration, Email to send documents." : !customer?.email ? "Add an email address to the linked customer to send documents." : null } });
}));

// AI-REACH: action sales:prepare-document
// UI-SCREEN: /sales/{id}
documentsRouter.post("/", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "sales:prepare-document"))) return;
  const body = PrepareDocument.safeParse(req.body);
  if (!body.success) return badBody(res, body.error);
  if (!await orderHere(req)) { res.status(404).json({ error: { code: "not_found", message: "Order not found." } }); return; }
  try {
    res.json(await prepareDocument(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, body.data, instanceOf(req)));
  } catch (e) { res.status(400).json({ error: { code: "document_not_ready", message: e instanceof Error ? e.message : "The document could not be prepared." } }); }
}));

documentsRouter.get("/:kind/pdf", asyncHandler(async (req, res) => {
  const kind = Kind.safeParse(req.params.kind);
  const order = await orderHere(req);
  if (!kind.success || !order) { res.status(404).json({ error: { code: "not_found", message: "Document not found." } }); return; }
  const doc = await tenantDb(req).selectFrom("sales_order_documents").selectAll().where("order_id", "=", order.id).where("kind", "=", kind.data).executeTakeFirst();
  if (!doc) { res.status(404).json({ error: { code: "not_found", message: "Prepare the document first." } }); return; }
  res.type("application/pdf").attachment(`${kind.data}-${doc.id}.pdf`).send(Buffer.from(await documentPdf(doc.snapshot, await documentPayment(order, sessionUser(req)?.id ?? null))));
}));

// AI-REACH: action sales:send-document
// UI-SCREEN: /sales/{id}
documentsRouter.post("/send", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: customer document email stays owner-only, including when a capability was granted; the shared service checks that role.
  if (!(await requireCapability(req, res, "sales:send-document"))) return;
  const source = await platform().auth.requestSource();
  if (sessionUser(req)?.ai_door || (source && (source.auth_method !== "session" || source.via !== null))) {
    res.status(403).json({ error: { code: "needs_a_person", message: "Use the document sending action so its confirm card asks the owner first." } });
    return;
  }
  try { res.json(await sendDocument(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!, req.body, instanceOf(req))); }
  catch (error) {
    if (!(error instanceof DocumentSendRefusal)) throw error;
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  }
}));
