import { z } from "zod";
const field = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
export const RecordTemplateSchema = z.object({ label: z.string().min(1).max(100), fields: z.record(z.unknown()) });
export type RecordTemplate = z.infer<typeof RecordTemplateSchema>;
export const ReceiptDraftSchema = z.object({ vendor_kind: z.string().min(3).max(80), vendor_field: field, cost_field: field, cycle_field: field, expiry_field: field, quantity_field: field, custom_months_field: field.optional() });
export type ReceiptDraftConfig = z.infer<typeof ReceiptDraftSchema>;
export interface RenewalReceiptDraft {
  name: string;
  fields: Record<string, unknown>;
  vendor: string | null;
  vendor_kind: string;
  vendor_field: string;
  file_id?: string;
  review_required: true;
}

export const RenewalBindingSchema = z.object({ expiry: field, cycle: field, custom_months: field, auto_renews: field, notice_days: field, cost: field, quantity: field, publisher: field });
export type RenewalFieldBinding = z.infer<typeof RenewalBindingSchema>;
