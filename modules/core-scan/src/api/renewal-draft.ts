import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ReceiptDraftSchema, type RenewalReceiptDraft } from "@cobblr/platform-contract/record-creation";
import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";
import { parseReceipt } from "../services/receipt.js";
import { renewalDraft } from "../services/renewal-draft.js";
import type { ParsedReceipt } from "../services/receipt-shared.js";

const Body = z.object({ target_kind: z.string().min(3).max(80), file_id: z.string().uuid().optional(), inbox_id: z.string().uuid().optional(), binding: ReceiptDraftSchema }).refine(d => !!d.file_id !== !!d.inbox_id, "Choose one receipt or inbox item");
export function registerRenewalDraftHandler(): void {
  platform().actions.registerHandler("core-scan.renewal-draft", async ctx => {
    const parsed = Body.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: "Choose a receipt and the collection to draft into." };
    const d = parsed.data;
    const defs = await platform().entities.fieldsFor(ctx.orgId, d.target_kind);
    if (!Object.entries(d.binding).filter(([key]) => key.endsWith("_field")).every(([,value]) => defs.some(f => f.name === value))) return { ok: false, error: "The collection does not have these receipt fields." };
    if (!defs.some(f => f.name === d.binding.vendor_field && f.type === "relation" && f.ref_kind === d.binding.vendor_kind)) return { ok: false, error: "Choose the vendor field this collection links to." };
    let receipt: ParsedReceipt;
    let fileId = d.file_id;
    if (d.file_id) {
      const result = await parseReceipt(ctx.orgId, d.file_id, ctx.userId, undefined, { requireTransaction: true });
      if (!result.ok) return { ok: false, error: result.reason };
      receipt = result.receipt;
    } else {
      const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreScanDB>;
      const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", d.inbox_id!).executeTakeFirst();
      if (!row) return { ok: false, error: "This receipt is no longer in the inbox." };
      fileId = row.image_file_id ?? undefined;
      const m = (row.suggested_metadata ?? {}) as Record<string, unknown>;
      receipt = { vendor: m.receipt_vendor ?? null, date: m.receipt_date ?? null, currency: m.receipt_currency ?? null, total: m.line_total ?? m.total_charged ?? null, items: [{ description: row.suggested_name ?? "Renewal", qty: row.quantity ?? 1 }], renewal: m.receipt_renewal } as ParsedReceipt;
    }
    const draft = renewalDraft(receipt);
    const fields: Record<string, unknown> = {};
    if (draft.cost) fields[d.binding.cost_field] = { ...draft.cost, currency: draft.cost.currency ?? await platform().money.currency(ctx.orgId) };
    if (draft.custom_months && d.binding.custom_months_field) fields[d.binding.custom_months_field] = draft.custom_months;
    if (draft.billing_cycle) fields[d.binding.cycle_field] = draft.billing_cycle;
    if (draft.next_date) fields[d.binding.expiry_field] = draft.next_date;
    if (draft.quantity) fields[d.binding.quantity_field] = draft.quantity;
    if (draft.vendor) {
      const candidates = await platform().entities.list(ctx.orgId, d.binding.vendor_kind, { q: draft.vendor, limit: 20 });
      const found = candidates.items.find(row => row.title.toLocaleLowerCase() === draft.vendor!.toLocaleLowerCase());
      if (found) fields[d.binding.vendor_field] = found.id;
    }
    const result: RenewalReceiptDraft = { name: draft.name, fields, vendor: draft.vendor, vendor_kind: d.binding.vendor_kind, vendor_field: d.binding.vendor_field, file_id: fileId, review_required: true };
    return { ok: true, result, summary: "Receipt draft ready. Check the vendor, cost, billing cycle and renewal date before saving." };
  });
}
