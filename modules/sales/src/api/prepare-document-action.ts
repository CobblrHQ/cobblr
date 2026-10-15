import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { prepareDocument } from "../documents.js";

export function registerPrepareDocumentAction(): void {
  platform().actions.registerHandler("sales.prepare-document", async ctx => {
    const record = requireActionEntity(ctx);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<SalesDB>;
    try {
      const result = await prepareDocument(db, ctx.orgId, ctx.userId, record.id, ctx.args);
      const workspace = await platform().orgs.get(ctx.orgId);
      const order = await db.selectFrom("sales_orders").select("customer_id").where("id", "=", record.id).executeTakeFirst();
      const recipient = order?.customer_id ? await db.selectFrom("sales_customers").select("email").where("id", "=", order.customer_id).where("instance", "=", result.document.instance).executeTakeFirst() : null;
      const { logo, ...document } = result.document.snapshot;
      return { ok: true, version: result.document.revision, email_to: recipient?.email ?? null, number: result.document.number, document, logo_included: !!logo, reused: result.reused,
        download_url: workspace ? result.document.instance === "sales" ? `/api/v1/orgs/${workspace.slug}/modules/sales/orders/${record.id}/documents/${result.document.kind}/pdf` : `/api/v1/orgs/${workspace.slug}/instances/${encodeURIComponent(result.document.instance)}/items/${record.id}/documents/${result.document.kind}/pdf` : null };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "The document could not be prepared." }; }
  });
}
