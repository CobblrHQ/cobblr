import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { DigifabDB } from "./db.js";
import { ProductionUnitRef } from "./production-store.js";
export const NewProductionUnit = z.object({ product: ProductionUnitRef, serial: z.string().trim().min(1).max(160).optional(), pattern: z.string().min(1).max(120).optional(), customer_code: z.string().max(30).optional(), product_code: z.string().max(30).optional(), details: z.object({ revision: z.string().max(200).optional(), customer: ProductionUnitRef.optional(), lot: z.string().max(160).optional(), panel: z.string().max(160).optional(), bom_revision: z.string().max(200).optional(), firmware_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().default({}) }).strict();
function weekOf(date: Date) {
 const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
 d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
 const year = d.getUTCFullYear(), first = Date.UTC(year, 0, 1);
 return String(year).slice(-2) + String(Math.ceil(((d.getTime() - first) / 86_400_000 + 1) / 7)).padStart(2, "0");
}
export function productionSerial(pattern: string, count: number, customer: string, product: string, date = new Date()) {
 if (!pattern.includes("{#####}") || /\{(?!#####\}|YYWW\}|CUST\}|PROD\})/.test(pattern) || count < 1 || count > 99_999) throw new Error("Use {#####} and optional {YYWW}, {CUST} and {PROD} in the serial pattern.");
 const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);
 return pattern.replaceAll("{#####}", String(count).padStart(5, "0")).replaceAll("{YYWW}", weekOf(date)).replaceAll("{CUST}", safe(customer)).replaceAll("{PROD}", safe(product));
}
export async function mintProductionUnit(db: Kysely<DigifabDB>, orgId: string, userId: string, raw: unknown) {
 const input = NewProductionUnit.parse(raw), model = await platform().entities.lookup(orgId, input.product.kind, input.product.id);
 const kind = await platform().entities.getKind(input.product.kind);
 if (!model || kind?.profile !== "stock-material") throw new Error("Choose a stock product to give each board its own unit record.");
 const writer = await platform().entities.getWriter(orgId, input.product.kind);
 if (!writer?.findByKey) throw new Error("Enable this product's inventory writer before serializing boards.");
 const findByKey = writer.findByKey.bind(writer);
 return db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`production-serial:${input.product.kind}:${input.product.id}`}))`.execute(trx);
  await trx.insertInto("digifab_test_numbering").values({ product_kind: input.product.kind, product_id: input.product.id }).onConflict(c => c.columns(["product_kind", "product_id"]).doNothing()).execute();
  let numbering = await trx.selectFrom("digifab_test_numbering").selectAll().where("product_kind", "=", input.product.kind).where("product_id", "=", input.product.id).forUpdate().executeTakeFirstOrThrow();
  if (input.pattern || input.customer_code || input.product_code) {
   productionSerial(input.pattern ?? numbering.pattern, numbering.next_number, input.customer_code ?? numbering.customer_code, input.product_code ?? numbering.product_code);
   numbering = await trx.updateTable("digifab_test_numbering").set({ pattern: input.pattern ?? numbering.pattern, customer_code: input.customer_code ?? numbering.customer_code, product_code: input.product_code ?? numbering.product_code }).where("product_kind", "=", input.product.kind).where("product_id", "=", input.product.id).returningAll().executeTakeFirstOrThrow();
  }
  let serial = input.serial ?? productionSerial(numbering.pattern, numbering.next_number, numbering.customer_code, numbering.product_code);
  let existing = await trx.selectFrom("digifab_test_units").selectAll().where("product_kind", "=", input.product.kind).where("product_id", "=", input.product.id).where("serial", "=", serial).executeTakeFirst();
  if (input.serial && existing) return existing;
  let next = numbering.next_number;
  while (!input.serial && existing) {
   serial = productionSerial(numbering.pattern, ++next, numbering.customer_code, numbering.product_code);
   existing = await trx.selectFrom("digifab_test_units").selectAll().where("product_kind", "=", input.product.kind).where("product_id", "=", input.product.id).where("serial", "=", serial).executeTakeFirst();
  }
  if (!input.serial) await trx.updateTable("digifab_test_numbering").set({ next_number: next + 1 }).where("product_kind", "=", input.product.kind).where("product_id", "=", input.product.id).execute();
  const source = `${input.product.id}:${serial}`;
  const unitId = await findByKey(orgId, { field: "production_unit_key", metadata: true }, source) ?? await writer.create(orgId, { name: `${model.title} · ${serial}`, qty: 1, unit: "each", serial_number: serial, metadata: { production_unit_key: source, ...input.details } });
  const pairs = await platform().entities.walkPairings(orgId, { kind: input.product.kind, id: unitId }, { rel: "unit-of", dir: "out" });
  if (!pairs.some(p => p.id === input.product.id)) await platform().pairings.create({ orgId, sourceKind: input.product.kind, sourceId: unitId, targetKind: input.product.kind, targetId: input.product.id, relationshipKind: "unit-of", createdBy: userId });
  return trx.insertInto("digifab_test_units").values({ unit_kind: input.product.kind, unit_id: unitId, product_kind: input.product.kind, product_id: input.product.id, serial, details: input.details }).returningAll().executeTakeFirstOrThrow();
 });
}
export const NewProductionJig = z.object({ asset_id: z.string().uuid().optional(), name: z.string().trim().min(1).max(200), plans: z.array(z.string().uuid()).min(1).max(100), pin_map: z.string().max(16_000).default(""), maintenance_every: z.number().int().positive().max(10_000_000).default(1000) }).strict();
export async function saveProductionJig(db: Kysely<DigifabDB>, orgId: string, raw: unknown) {
 const input = NewProductionJig.parse(raw), writer = await platform().entities.getWriter(orgId, "assets:asset");
 if (!writer) throw new Error("Enable Assets before adding a test jig.");
 for (const id of input.plans) if (!await db.selectFrom("digifab_test_plans").select("id").where("id", "=", id).executeTakeFirst()) throw new Error("Choose an existing test plan for this jig.");
 const asset_id = input.asset_id ?? await writer.create(orgId, { name: input.name, type: "Test jig", notes: input.pin_map });
 if (!await platform().entities.lookup(orgId, "assets:asset", asset_id)) throw new Error("Choose this workspace's jig asset.");
 const row = await db.insertInto("digifab_test_jigs").values({ ...input, asset_id, plans: sql`${JSON.stringify(input.plans)}::jsonb` }).onConflict(c => c.column("asset_id").doUpdateSet({ name: input.name, plans: sql`${JSON.stringify(input.plans)}::jsonb`, pin_map: input.pin_map, maintenance_every: input.maintenance_every })).returningAll().executeTakeFirstOrThrow();
 await reconcileProductionJig(db, orgId, asset_id);
 return row;
}
export async function reconcileProductionJig(db: Kysely<DigifabDB>, orgId: string, id: string) {
 return db.transaction().execute(async trx => {
 await sql`select pg_advisory_xact_lock(hashtext(${`production-jig-projection:${id}`}))`.execute(trx);
 const row = await trx.selectFrom("digifab_test_jigs").selectAll().where("asset_id", "=", id).executeTakeFirstOrThrow();
 const writer = await platform().entities.getWriter(orgId, "assets:asset");
 if (!writer?.mergeMetadata) throw new Error("Enable the jig asset's usage counter before Start.");
 await writer.mergeMetadata(orgId, id, { production_cycles: row.cycle_count });
 const outcome = normaliseActionResult(await platform().actions.invoke("core-maintenance:ensure-usage", { orgId, userId: null, entity: { kind: "assets:asset", id }, args: { name: `${row.name} pogo pins`, counter_field: "production_cycles", counter_every: row.maintenance_every }, event: { name: "digifab.test.jig-used", payload: { jig_id: id }, actor: { user_id: null, display_name: null, auth_method: "system" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" } }), "core-maintenance:ensure-usage");
 if (!outcome.ok) throw new Error("Enable Maintenance and reconcile this jig's cycle schedule before Start.");
 return outcome;
 });
}
