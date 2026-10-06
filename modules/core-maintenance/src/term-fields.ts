import { z } from "zod";
import { isCurrency } from "@cobblr/platform-contract/money";
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import { MaintenanceRefusal } from "./refusal.js";

export const TermDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(v + "T12:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "Enter a valid date");
export const TermFields = {
  file_id: z.string().uuid().optional(),
  term_start: TermDate.optional(), term_end: TermDate.optional(),
  cost_cents: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
  currency: z.string().refine(isCurrency, "Choose a currency").optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  quantity: z.number().positive().max(10_000_000).nullable().optional(),
};
export const TermBody = z.object(TermFields);
export async function termValues(db: Kysely<CoreMaintenanceDB>, orgId: string,
  s: { id: string; entity_module: string; entity_type: string; entity_id: string },
  currentExpiry: Date, expiry: Date, d: z.infer<typeof TermBody>) {
  const last = await db.selectFrom("core_maintenance_entries").selectAll().where("schedule_id", "=", s.id)
    .where("is_term", "=", true).orderBy(sql`term_end desc nulls last`).orderBy("performed_at", "desc").orderBy("id").executeTakeFirst();
  const start = d.term_start ? new Date(d.term_start + "T12:00:00Z") : currentExpiry;
  if (start < currentExpiry || (last?.term_end && start < last.term_end)) throw new MaintenanceRefusal("The term start cannot overlap the previous term");
  if (expiry <= start) throw new MaintenanceRefusal("The term end must be after its start");
  const currency = d.currency ?? last?.currency ?? await platform().money.currency(orgId);
  const record = await platform().entities.lookup(orgId, `${s.entity_module}:${s.entity_type}`, s.entity_id);
  const fields = record?.fields ?? {};
  const publisher = fields.publisher ?? (fields.metadata as Record<string, unknown> | undefined)?.publisher;
  return {
    is_term: true, term_start: start, term_end: expiry, previous_term_id: last?.id ?? null,
    cost_cents: d.cost_cents === undefined ? last?.cost_cents ?? null : d.cost_cents,
    currency, reference: d.reference ?? null,
    quantity: d.quantity === undefined ? last?.quantity ?? null : d.quantity,
    metadata: { money_currency_cost_cents: currency, ...(typeof publisher === "string" ? { publisher } : {}) },
  };
}
