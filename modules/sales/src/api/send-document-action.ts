import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { formatStoredMoney } from "@cobblr/platform-contract/money";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { documentForSend, DocumentSendRefusal, sendDocument } from "../document-send.js";

export function registerSendDocumentAction(): void {
  platform().actions.registerPlanner("sales.send-document", async ctx => {
    try {
      const db = await platform().tenants.getDb(ctx.orgId) as Kysely<SalesDB>;
      const { doc, to } = await documentForSend(db, ctx.orgId, ctx.userId, requireActionEntity(ctx).id, ctx.args);
      return { title: `Email ${doc.kind} ${doc.number} to ${to}`, lines: [
        `${doc.snapshot.shop_name}: ${formatStoredMoney(doc.snapshot.total, "amount", { currency: doc.snapshot.currency })}.`,
        `Attach the saved ${doc.kind} PDF, dated ${doc.snapshot.date}.`,
        ...(doc.snapshot.deadline ? [`${doc.kind === "quote" ? "Valid until" : "Due"} ${doc.snapshot.deadline}.`] : []),
        "This emails the customer and cannot be taken back.",
      ] };
    } catch (error) { if (error instanceof DocumentSendRefusal) return { error: error.message }; throw error; }
  });
  platform().actions.registerHandler("sales.send-document", async ctx => {
    if (ctx.event.trigger_type !== "user-invoked" || ctx.wire) return { ok: false, error: "A workspace owner must confirm this send in Cobblr." };
    const source = await platform().auth.requestSource();
    if (source && source.auth_method !== "session") return { ok: false, error: "A workspace owner must confirm this send in Cobblr." };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<SalesDB>;
    try { return await sendDocument(db, ctx.orgId, ctx.userId, requireActionEntity(ctx).id, ctx.args); }
    catch (error) { if (error instanceof DocumentSendRefusal) return { ok: false, code: error.code, error: error.message }; throw error; }
  });
}
