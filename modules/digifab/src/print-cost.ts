// What a finished print cost: the grams it took off each spool at that spool's
// price per gram, plus its machine time when the printer (or its pool) has an
// hour rate. Kept on the job once, at completion, in the workspace's currency.
//
// A spool's price per gram is its price ("Price / spool", the part's cost) over
// its net filament weight (initial_g), else its filament type's price per kg.
// Grams from a spool with neither are unpriced, and a job with any unpriced
// grams keeps no cost at all: it reads "not priced", never a cheaper number.

import { platform } from "@cobblr/platform-contract";
import { fieldCurrency, readMoney, type Money } from "@cobblr/platform-contract/money";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";

const SPOOL_KIND = "inventory:part";

export type CostLine =
  | { part_id: string; grams: number; per_gram: number; amount: number; currency: string }
  | { part_id: string; grams: number; unpriced: true };
export interface MachineLine { hours: number; rate: number; amount: number; currency: string; from: "printer" | "pool" }
export interface CostDetail { lines: CostLine[]; machine: MachineLine | null; unpriced: boolean }

type Fields = Record<string, unknown>;
const positive = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const merged = (fields: Fields): { all: Fields; metadata: Fields } => {
  const metadata = fields.metadata && typeof fields.metadata === "object" ? (fields.metadata as Fields) : {};
  return { all: { ...metadata, ...fields }, metadata };
};

/** A spool's price per gram: its price over its net filament weight (the
 *  filament bundle's "Price / spool" and initial_g); else its cost per unit
 *  over the grams in one unit (a part kept in kg at 20 a kg); else its
 *  filament type's price per kg. Pure. */
export function pricePerGram(spool: Fields, type: Fields | null, workspaceCurrency: string, gramsPerUnit: number | null = null): { perGram: number; currency: string } | null {
  const s = merged(spool);
  const price = readMoney(s.all.cost, "amount", fieldCurrency(s.metadata, "cost", workspaceCurrency));
  const net = positive(s.all.initial_g);
  if (price && price.amount > 0 && net) return { perGram: price.amount / net, currency: price.currency };
  if (price && price.amount > 0 && gramsPerUnit && gramsPerUnit > 0) return { perGram: price.amount / gramsPerUnit, currency: price.currency };
  if (!type) return null;
  const t = merged(type);
  const perKg = readMoney(t.all.price_per_kg, "amount", fieldCurrency(t.metadata, "price_per_kg", workspaceCurrency));
  return perKg && perKg.amount > 0 ? { perGram: perKg.amount / 1000, currency: perKg.currency } : null;
}

/** The grams a completed job took and the spool each came off: the plan its
 *  completion committed, else (a job finished before plans) its picked spool
 *  or what was drawn. */
export function gramsBySpool(job: { material_part_id: string | null; material_grams: string | null; material_drawn: unknown; material_plan?: unknown }): Array<{ part_id: string; grams: number }> {
  const planned = (job.material_plan as { draws?: unknown } | null | undefined)?.draws;
  if (Array.isArray(planned)) return planned.flatMap((d) => {
    const part = (d as { part_id?: unknown })?.part_id, grams = positive((d as { grams?: unknown })?.grams);
    return typeof part === "string" && grams ? [{ part_id: part, grams }] : [];
  });
  const total = positive(job.material_grams);
  if (job.material_part_id) return total ? [{ part_id: job.material_part_id, grams: total }] : [];
  const drawn = Array.isArray(job.material_drawn) ? job.material_drawn : [];
  return drawn.flatMap((d) => {
    const part = (d as { part_id?: unknown })?.part_id, grams = positive((d as { grams?: unknown })?.grams);
    return typeof part === "string" && grams ? [{ part_id: part, grams }] : [];
  });
}

/** The hour rate a printer runs at: its own, else its pool's. */
async function hourRate(db: Kysely<DigifabDB>, job: { connection_id: string | null; target_device: string | null; target_pool: string | null }, workspaceCurrency: string): Promise<(Money & { from: "printer" | "pool" }) | null> {
  if (job.connection_id && job.target_device) {
    const own = await db.selectFrom("digifab_device_settings").select(["hour_rate", "hour_rate_currency"])
      .where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).executeTakeFirst();
    const rate = positive(own?.hour_rate);
    if (rate) return { amount: rate, currency: own?.hour_rate_currency || workspaceCurrency, from: "printer" };
  }
  let pools = job.target_pool ? await db.selectFrom("digifab_pools").select("config").where("id", "=", job.target_pool).execute() : [];
  if (!pools.length && job.connection_id && job.target_device) {
    pools = await db.selectFrom("digifab_pools").innerJoin("digifab_pool_members", "digifab_pool_members.pool_id", "digifab_pools.id")
      .select("digifab_pools.config").where("digifab_pool_members.connection_id", "=", job.connection_id)
      .where("digifab_pool_members.remote_device_id", "=", job.target_device).orderBy("digifab_pools.name").execute();
  }
  for (const p of pools) {
    const config = (p.config ?? {}) as Fields;
    const rate = positive(config.hour_rate);
    if (rate) return { amount: rate, currency: typeof config.hour_rate_currency === "string" ? config.hour_rate_currency : workspaceCurrency, from: "pool" };
  }
  return null;
}

/** Price a completed job once and keep it on the job. `hours` is its machine
 *  time, the same figure print.completed reports. Returns what was kept, or
 *  null when the job was priced already. */
export async function priceCompletedJob(db: Kysely<DigifabDB>, orgId: string, jobId: string, hours: number | null): Promise<{ amount: number | null; currency: string; detail: CostDetail } | null> {
  const job = await db.selectFrom("digifab_jobs")
    .select(["id", "material_part_id", "material_grams", "material_drawn", "material_plan", "connection_id", "target_device", "target_pool", "cost_detail"])
    .where("id", "=", jobId).executeTakeFirst();
  if (!job || job.cost_detail != null) return null;
  const workspace = await platform().money.currency(orgId);
  const grams = gramsBySpool(job);
  const spools = grams.length ? await platform().entities.lookupMany(orgId, grams.map((g) => ({ kind: SPOOL_KIND, id: g.part_id })), { system: true }) : [];
  const typeOf = new Map<string, string>();
  if (grams.length) {
    const pairs = await platform().pairings.findBySources({ orgId, sourceKind: SPOOL_KIND, sourceIds: grams.map((g) => g.part_id), targetKind: SPOOL_KIND, relationshipKind: "instance-of" });
    for (const p of pairs) typeOf.set(p.sourceId, p.targetId);
  }
  const types = typeOf.size ? await platform().entities.lookupMany(orgId, [...new Set(typeOf.values())].map((id) => ({ kind: SPOOL_KIND, id })), { system: true }) : [];
  const fieldsOf = (list: typeof spools, id: string | undefined) => (id ? list.find((e) => e?.id === id)?.fields ?? null : null);

  const perUnit = new Map<string, number | null>();
  for (const s of spools) {
    const unit = typeof s?.fields?.unit === "string" ? s.fields.unit : "";
    if (unit && !perUnit.has(unit)) perUnit.set(unit, await platform().units.convert(orgId, 1, unit, "g").catch(() => null));
  }
  const lines: CostLine[] = grams.map((g) => {
    const spool = fieldsOf(spools, g.part_id);
    const unit = typeof spool?.unit === "string" ? spool.unit : "";
    const price = spool ? pricePerGram(spool, fieldsOf(types, typeOf.get(g.part_id)), workspace, unit ? perUnit.get(unit) ?? null : null) : null;
    return price
      ? { part_id: g.part_id, grams: g.grams, per_gram: price.perGram, amount: g.grams * price.perGram, currency: price.currency }
      : { part_id: g.part_id, grams: g.grams, unpriced: true as const };
  });
  const rate = hours && hours > 0 ? await hourRate(db, job, workspace) : null;
  const machine: MachineLine | null = rate && hours ? { hours, rate: rate.amount, amount: hours * rate.amount, currency: rate.currency, from: rate.from } : null;

  const priced = lines.filter((l): l is Extract<CostLine, { per_gram: number }> => "per_gram" in l);
  const values = [...priced, ...(machine ? [machine] : [])];
  let unpriced = lines.length > priced.length || values.length === 0;
  let amount: number | null = null;
  if (!unpriced) {
    // UTC-DAY OK: the exchange-rate day a price is converted on, not anyone's calendar
    const day = new Date().toISOString().slice(0, 10);
    const total = await platform().money.total(orgId, values.map((v) => ({ value: { amount: v.amount, currency: v.currency }, day })), workspace);
    if (Object.keys(total.excluded).length) unpriced = true;
    else amount = Math.round(total.amount * 10_000) / 10_000;
  }
  const detail: CostDetail = { lines, machine, unpriced };
  await db.updateTable("digifab_jobs")
    .set({ cost_amount: amount == null ? null : String(amount), cost_currency: workspace, cost_detail: JSON.stringify(detail) as never })
    .where("id", "=", jobId).where("cost_detail", "is", null).execute();
  return { amount, currency: workspace, detail };
}
