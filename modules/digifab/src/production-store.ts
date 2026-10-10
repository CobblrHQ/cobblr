import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely, type Generated } from "kysely";
import { z } from "zod";
import { assertNoWirelessCredentialFields, validateProductionPlan, productionPlanHash, judgeProductionObservation, ProductionObservationSchema, type ProductionPlan, type ProductionTestResult } from "@cobblr/platform-contract/production-test";
import type { DigifabDB } from "./db.js";
export interface TestPlanHead { id: Generated<string>; latest_version: Generated<number>; created_at: Generated<Date> }
export interface TestPlanVersion { plan_id: string; version: number; name: string; plan: ProductionPlan; plan_hash: string; created_at: Generated<Date> }
export interface TestUnit { unit_kind: string; unit_id: string; product_kind: string; product_id: string; serial: string; details: Generated<Record<string, unknown>>; created_at: Generated<Date> }
export interface TestJig { asset_id: string; name: string; plans: Generated<unknown>; pin_map: Generated<string>; cycle_count: Generated<number>; maintenance_every: Generated<number>; created_at: Generated<Date> }
export interface TestRun { id: Generated<string>; unit_kind: string; unit_id: string; plan_id: string; plan_version: number; plan: ProductionPlan; plan_hash: string; attempt: number; operator_id: string; station: string; jig_id: string | null; bridge_connection_id: Generated<string | null>; jig_cycle: Generated<number | null>; unit_snapshot: Generated<Record<string, unknown>>; metadata: Generated<Record<string, unknown>>; result: Generated<ProductionTestResult | null>; prepared_at: Generated<Date>; finished_at: Generated<Date | null> }
export interface TestNumbering { product_kind: string; product_id: string; next_number: Generated<number>; pattern: Generated<string>; customer_code: Generated<string>; product_code: Generated<string> }
export interface TestDelivery { run_id: string; staged: Generated<boolean>; acknowledged: Generated<boolean>; projected: Generated<boolean>; last_error: Generated<string | null>; updated_at: Generated<Date> }
export interface TestDisposition { id: Generated<string>; run_id: string; status: "reworked" | "scrapped"; operator_id: string; notes: Generated<string>; created_at: Generated<Date> }
export const ProductionUnitRef = z.object({ kind: z.string().min(3).max(160), id: z.string().uuid() }).strict();
export const PrepareAttempt = z.object({ unit: ProductionUnitRef, plan_id: z.string().uuid(), plan_version: z.number().int().positive(), operator_id: z.string().uuid(), station: z.string().trim().min(1).max(200), jig_id: z.string().uuid().nullable(), bridge_connection_id: z.string().uuid().optional(), unit_snapshot: z.record(z.unknown()).optional() }).strict();
export async function saveProductionPlan(db: Kysely<DigifabDB>, raw: unknown, id?: string) {
 const input = validateProductionPlan(raw);
 if (!input.product && !input.board_revision) throw new Error("Choose a product or board revision for this plan.");
 return db.transaction().execute(async trx => {
  const head = id ? await trx.selectFrom("digifab_test_plans").selectAll().where("id", "=", z.string().uuid().parse(id)).forUpdate().executeTakeFirstOrThrow() : await trx.insertInto("digifab_test_plans").defaultValues().returningAll().executeTakeFirstOrThrow();
  const plan = { ...input, version: head.latest_version + 1 };
  await trx.insertInto("digifab_test_plan_versions").values({ plan_id: head.id, version: plan.version, name: plan.name, plan, plan_hash: productionPlanHash(plan) }).execute();
  await trx.updateTable("digifab_test_plans").set({ latest_version: plan.version }).where("id", "=", head.id).execute();
  return { id: head.id, version: plan.version, plan };
 });
}
export async function prepareProductionAttempt(db: Kysely<DigifabDB>, raw: z.infer<typeof PrepareAttempt>) {
 const input = PrepareAttempt.parse(raw);
 return db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`production-unit:${input.unit.kind}:${input.unit.id}`}))`.execute(trx);
  const saved = await trx.selectFrom("digifab_test_plan_versions").selectAll().where("plan_id", "=", input.plan_id).where("version", "=", input.plan_version).executeTakeFirstOrThrow();
  if (saved.plan.required_jig_id && saved.plan.required_jig_id !== input.jig_id) throw new Error("Scan the jig required by this plan.");
  const latest = await trx.selectFrom("digifab_test_runs").selectAll().where("unit_kind", "=", input.unit.kind).where("unit_id", "=", input.unit.id).orderBy("attempt", "desc").executeTakeFirst();
  if (latest && !latest.finished_at) throw new Error("Finish or abort the pending attempt before retesting this unit.");
  const disposition = latest && await trx.selectFrom("digifab_test_dispositions").selectAll().where("run_id", "=", latest.id).orderBy("created_at", "desc").executeTakeFirst();
  if (disposition?.status === "scrapped") throw new Error("This unit is scrapped. Keep its test history.");
  let jig_cycle: number | null = null;
  if (input.jig_id) {
   const jig = await trx.selectFrom("digifab_test_jigs").selectAll().where("asset_id", "=", input.jig_id).forUpdate().executeTakeFirstOrThrow();
   if (!Array.isArray(jig.plans) || !jig.plans.includes(input.plan_id)) throw new Error("This jig is not approved for this plan.");
   jig_cycle = jig.cycle_count + 1;
   await trx.updateTable("digifab_test_jigs").set({ cycle_count: jig_cycle }).where("asset_id", "=", input.jig_id).execute();
  }
  const row = await trx.insertInto("digifab_test_runs").values({ unit_kind: input.unit.kind, unit_id: input.unit.id, plan_id: input.plan_id, plan_version: input.plan_version, plan: saved.plan, plan_hash: saved.plan_hash, operator_id: input.operator_id, station: input.station, jig_id: input.jig_id, bridge_connection_id: input.bridge_connection_id ?? null, unit_snapshot: input.unit_snapshot ?? {}, jig_cycle, attempt: (latest?.attempt ?? 0) + 1 }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto("digifab_test_delivery").values({ run_id: row.id }).execute();
  return { ...row, unit: input.unit };
 });
}
export function verifyProductionResult(plan: ProductionPlan, result: ProductionTestResult, unit?: { serial?: string | null }): ProductionTestResult {
 // A result is stored as it arrives, so a wireless credential is refused here, before anything is kept.
 assertNoWirelessCredentialFields(result);
 if (!isDeepStrictEqual(validateProductionPlan(result.plan), plan) || productionPlanHash(result.plan) !== result.plan_hash) throw new Error("Use this attempt's exact plan and limits.");
 if (!Array.isArray(result.steps) || result.steps.length !== plan.steps.length) throw new Error("Keep a result for every step, skipped steps included.");
 if (!Array.isArray(result.outputs_off) || result.outputs_off.length !== plan.controlled_instruments.length || new Set(result.outputs_off.map(o => o.instrument)).size !== result.outputs_off.length || result.outputs_off.some(o => !plan.controlled_instruments.includes(o.instrument))) throw new Error("Keep output-off confirmation for every controlled instrument.");
 let failed = false, stopped = false;
 for (const [index, step] of plan.steps.entries()) {
  const recorded = result.steps[index]!;
  if (recorded.id !== step.id || recorded.kind !== step.kind || recorded.name !== step.name || !isDeepStrictEqual(recorded.limits, step.limits)) throw new Error("Keep this plan's ordered steps and limits.");
  if (!["pass", "fail", "skip"].includes(recorded.result)) throw new Error("Choose pass, fail or skip for every step.");
  z.string().datetime().parse(recorded.started_at); z.string().datetime().parse(recorded.finished_at);
  if (recorded.result === "skip") { if (!stopped && !["aborted", "error"].includes(result.status)) throw new Error("An untested unit cannot pass."); continue; }
  if (stopped) throw new Error("A stopped plan cannot run a later step.");
  const { id: _id, name: _name, kind: _kind, limits: _limits, result: _result, reason: _reason, started_at: _start, finished_at: _end, ...value } = recorded;
  const observation = ProductionObservationSchema.parse(value);
  if (recorded.result === "pass" && judgeProductionObservation(step, observation, unit).result !== "pass") throw new Error("The measurement does not pass its saved limits.");
  if (step.kind === "program" && recorded.result === "pass" && observation.firmware_hash !== step.firmware.sha256) throw new Error("The programmed firmware hash does not match this plan.");
  if (recorded.result === "fail") { failed = true; stopped = (step.on_fail ?? plan.on_fail) === "stop"; }
 }
 if (!result.outputs_off.every(o => o.confirmed === true) && result.status !== "error") throw new Error("Unconfirmed outputs cannot produce a passed unit.");
 if (!(["passed", "failed", "aborted", "error"] as const).includes(result.status) || result.status === "passed" && (failed || result.steps.some(s => s.result !== "pass"))) throw new Error("The unit's status does not match its step results.");
 z.string().datetime().parse(result.started_at); z.string().datetime().parse(result.finished_at);
 return result;
}
export async function finishProductionAttempt(db: Kysely<DigifabDB>, id: string, asked: ProductionTestResult) {
 const finish = async (trx: Kysely<DigifabDB>) => {
  const row = await trx.selectFrom("digifab_test_runs").selectAll().where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
  const result = verifyProductionResult(row.plan, asked, { serial: typeof row.unit_snapshot?.serial === "string" ? row.unit_snapshot.serial : null });
  if (row.finished_at) { if (!isDeepStrictEqual(row.result, JSON.parse(JSON.stringify(result)))) throw new Error("This immutable result was already saved. Retest as a new attempt."); return row; }
  return trx.updateTable("digifab_test_runs").set({ result, finished_at: new Date(result.finished_at) }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
 };
 return db.isTransaction ? finish(db) : db.transaction().execute(finish);
}
export async function productionUnitHistory(db: Kysely<DigifabDB>, unit: z.infer<typeof ProductionUnitRef>) {
 const runs = await db.selectFrom("digifab_test_runs").selectAll().where("unit_kind", "=", unit.kind).where("unit_id", "=", unit.id).orderBy("attempt", "desc").execute();
 const latest = runs[0];
 const dispositions = runs.length ? await db.selectFrom("digifab_test_dispositions").selectAll().where("run_id", "in", runs.map(r => r.id)).orderBy("created_at", "desc").execute() : [];
 const current = dispositions.find(d => d.run_id === latest?.id);
 return { unit, runs, dispositions, status: current?.status ?? latest?.result?.status ?? "untested" };
}
