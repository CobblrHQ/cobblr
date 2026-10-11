import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql, type Kysely, type Selectable } from "kysely";
import { likeEscape, platform, readJsonArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import { countOf } from "@cobblr/platform-contract/plural";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import type { ProductionTestResult } from "@cobblr/platform-contract/production-test";
import { stepChangesHardware, validateProductionPlan, type ProductionStep } from "@cobblr/platform-contract/production-test";
import { configuredControl } from "./bench.js";
import { pinProgramImages } from "./production-firmware.js";
import type { DigifabDB } from "./db.js";
import { PrepareAttempt, ProductionUnitRef, saveProductionPlan, prepareProductionAttempt, finishProductionAttempt, verifyProductionResult, productionUnitHistory } from "./production-store.js";
import { NewProductionUnit, NewProductionJig, mintProductionUnit, saveProductionJig, reconcileProductionJig } from "./production-records.js";
import { productionStatistics, productionCertificate } from "./production-reports.js";
const uuid = z.string().uuid();
export const PrepareStation = PrepareAttempt.omit({ operator_id: true, unit_snapshot: true }).extend({ bridge_connection_id: uuid });
async function bridge(orgId: string, id: string) {
 const driver = await platform().devices.getDriver(orgId, id);
 if (!driver || !("productionRequest" in driver) || typeof driver.productionRequest !== "function") throw new Error("Connect this station's production test bridge.");
 const request = driver.productionRequest.bind(driver) as (operation: string, args: Record<string, unknown>) => Promise<unknown>;
 return (operation: string, args: Record<string, unknown>) => request(operation, { ...args, workspace_id: orgId });
}
export async function prepareProductionStation(db: Kysely<DigifabDB>, orgId: string, operator: string, raw: unknown) {
 const input = PrepareStation.parse(raw), unit = await platform().entities.lookup(orgId, input.unit.kind, input.unit.id);
 if (!unit) throw new Error("Scan a unit in this workspace.");
 const registered = await db.selectFrom("digifab_test_units").selectAll().where("unit_kind", "=", input.unit.kind).where("unit_id", "=", input.unit.id).executeTakeFirst();
 if (!registered) throw new Error("Register this serialized unit for production test first.");
 const version = await db.selectFrom("digifab_test_plan_versions").selectAll().where("plan_id", "=", input.plan_id).where("version", "=", input.plan_version).executeTakeFirstOrThrow();
 if (version.plan.required_jig_id && version.plan.required_jig_id !== input.jig_id) throw new Error("Scan the jig required by this plan.");
 if (version.plan.product && (version.plan.product.kind !== registered.product_kind || version.plan.product.id !== registered.product_id)) throw new Error("Choose the test plan for this unit's product.");
 if (version.plan.board_revision && registered.details.revision !== version.plan.board_revision.id) throw new Error("Choose the test plan for this unit's board revision.");
 if (version.plan.customer && !isDeepStrictEqual(registered.details.customer, version.plan.customer)) throw new Error("Choose the test plan for this unit's customer.");
 await bridge(orgId, input.bridge_connection_id);
 const pending = await db.selectFrom("digifab_test_runs").selectAll().where("unit_kind", "=", input.unit.kind).where("unit_id", "=", input.unit.id).where("finished_at", "is", null).executeTakeFirst();
 if (pending && (pending.plan_id !== input.plan_id || pending.plan_version !== input.plan_version || pending.jig_id !== input.jig_id || pending.bridge_connection_id !== input.bridge_connection_id || pending.station !== input.station)) throw new Error("Finish or abort this unit's pending attempt before choosing a different plan or station.");
 const attempt = pending ? { ...pending, unit: input.unit } : await prepareProductionAttempt(db, { ...input, operator_id: operator, unit_snapshot: { serial: registered.serial, product: { kind: registered.product_kind, id: registered.product_id }, ...registered.details } });
 if (!pending) await platform().activity.log({ orgId, userId: operator, action: "test-run_created", ref: { module: "digifab", entityType: "test-run", entityId: attempt.id }, diff: { plan_version: attempt.plan_version, attempt: attempt.attempt } });
 await stageProductionAttempt(db, orgId, attempt.id);
 return attempt;
}
export async function stageProductionAttempt(db: Kysely<DigifabDB>, orgId: string, id: string) {
 const attempt = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
 if (!attempt.bridge_connection_id) throw new Error("Keep this attempt's original station connection.");
 const input = { unit: { kind: attempt.unit_kind, id: attempt.unit_id }, station: attempt.station };
 const registered = await db.selectFrom("digifab_test_units").selectAll().where("unit_kind", "=", attempt.unit_kind).where("unit_id", "=", attempt.unit_id).executeTakeFirstOrThrow();
 const call = await bridge(orgId, attempt.bridge_connection_id);
 if (attempt.jig_id) await reconcileProductionJig(db, orgId, attempt.jig_id);
 const artifacts: Record<string, { filename: string; sha256: string; data_b64: string; mime_type: string }> = {};
 let bytes = 0;
 for (const step of attempt.plan.steps) {
  const fileRef = step.kind === "program" ? step.firmware : step.kind === "script" ? step.script : step.kind === "operator" && step.image_file_id ? { file_id: step.image_file_id } : null;
  if (!fileRef || artifacts[fileRef.file_id]) continue;
  const file = await platform().files.read(orgId, fileRef.file_id); if (!file) throw new Error(`Keep the file used by ${step.name} in Files.`);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  if ("sha256" in fileRef && sha256 !== fileRef.sha256) throw new Error("The firmware or script hash changed. Save a new plan version.");
  bytes += file.bytes.length; if (bytes > 16 * 1024 * 1024) throw new Error("Prepare at most 16 MB of firmware, script and reference files in one attempt.");
  artifacts[fileRef.file_id] = { filename: file.filename, mime_type: file.mimeType, sha256, data_b64: Buffer.from(file.bytes).toString("base64") };
 }
 const jig = attempt.jig_id ? await db.selectFrom("digifab_test_jigs").selectAll().where("asset_id", "=", attempt.jig_id).executeTakeFirst() : null;
 const unit_labels = await platform().entities.labelValuesFor(orgId, input.unit.kind, input.unit.id), jig_labels = attempt.jig_id ? await platform().entities.labelValuesFor(orgId, "assets:asset", attempt.jig_id) : [];
 await call("prepare", { attempt: { id: attempt.id, serial: registered.serial, unit: input.unit, unit_labels, plan: attempt.plan, plan_hash: attempt.plan_hash, jig_id: attempt.jig_id, jig_labels, jig_name: jig?.name, jig_cycle: attempt.jig_cycle, ...(attempt.metadata?.jig_pins ? { jig_pins: attempt.metadata.jig_pins } : {}), operator_id: attempt.operator_id, station: input.station }, artifacts });
 await platform().pairings.create({ orgId, sourceKind: input.unit.kind, sourceId: input.unit.id, targetKind: "digifab:test-run", targetId: attempt.id, relationshipKind: "test-run", createdBy: attempt.operator_id });
 await db.updateTable("digifab_test_delivery").set({ staged: true, last_error: null, updated_at: new Date() }).where("run_id", "=", id).execute();
 return attempt;
}
export async function syncProductionAttempt(db: Kysely<DigifabDB>, orgId: string, id: string) {
 const saved = await db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`production-sync:${id}`}))`.execute(trx);
  const row = await trx.selectFrom("digifab_test_runs").selectAll().where("id", "=", uuid.parse(id)).executeTakeFirstOrThrow();
  if (row.result) return row;
  if (!row.bridge_connection_id) throw new Error("Keep this attempt's original bridge connection.");
  const call = await bridge(orgId, row.bridge_connection_id);
  const reply = await call("result", { id }) as { result?: ProductionTestResult; files?: Record<string, { data_b64: string; filename: string; mime_type: string; sha256: string }> };
  if (!reply.result) throw new Error("Finish or abort this attempt on its bridge before syncing.");
  const result = JSON.parse(JSON.stringify(reply.result)) as ProductionTestResult;
  verifyProductionResult(row.plan, result, { serial: typeof row.unit_snapshot?.serial === "string" ? row.unit_snapshot.serial : null });
  for (const step of result.steps) for (const attachment of step.attachments ?? []) {
   const file = reply.files?.[attachment.id]; if (!file) throw new Error("Keep every capture, photo and report on the bridge until it syncs.");
   const bytes = Buffer.from(file.data_b64, "base64");
   if (bytes.length > 2 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256 || file.sha256 !== attachment.sha256) throw new Error("The bridge attachment is incomplete or its hash changed.");
   const stored = await platform().files.write(orgId, bytes, { filename: attachment.filename, mimeType: attachment.mime_type }); if (!stored) throw new Error("Enable Files to retain production evidence.");
   attachment.id = stored.fileId;
   await platform().files.attach(orgId, { fileId: stored.fileId, source_module: "digifab", source_type: "test-run", source_id: id, role: attachment.role });
  }
  return finishProductionAttempt(trx, id, result);
 });
 await projectProductionUnit(db, orgId, { kind: saved.unit_kind, id: saved.unit_id });
 await platform().activity.log({ orgId, userId: saved.operator_id, action: "production-test_finished", ref: { module: "digifab", entityType: "test-run", entityId: id }, diff: { status: saved.result!.status, attempt: saved.attempt } });
 await (await bridge(orgId, saved.bridge_connection_id!))("ack", { id });
 await db.updateTable("digifab_test_delivery").set({ acknowledged: true, projected: true, last_error: null, updated_at: new Date() }).where("run_id", "=", id).execute();
 return saved;
}
export async function projectProductionUnit(db: Kysely<DigifabDB>, orgId: string, unit: z.infer<typeof ProductionUnitRef>) {
 await db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`production-projection:${unit.kind}:${unit.id}`}))`.execute(trx);
  const history = await productionUnitHistory(trx, unit), latest = history.runs[0];
  const registered = await trx.selectFrom("digifab_test_units").selectAll().where("unit_kind", "=", unit.kind).where("unit_id", "=", unit.id).executeTakeFirstOrThrow();
  const serial = latest?.result?.steps.find(s => s.serial)?.serial, firmware_hash = latest?.result?.steps.find(s => s.firmware_hash)?.firmware_hash;
  // Where this unit's serial was written on the board, as read back after writing.
  const written = latest?.result?.steps.find(s => s.result === "pass" && s.unit_write)?.unit_write;
  const writer = await platform().entities.getWriter(orgId, unit.kind); if (!writer?.mergeMetadata) throw new Error("Keep the serialized unit's writer available to save its latest test status.");
  if (serial && serial !== registered.serial) {
   await sql`select pg_advisory_xact_lock(hashtext(${`production-serial:${registered.product_kind}:${registered.product_id}`}))`.execute(trx);
   const other = await trx.selectFrom("digifab_test_units").select("unit_id").where("product_kind", "=", registered.product_kind).where("product_id", "=", registered.product_id).where("serial", "=", serial).executeTakeFirst();
   if (other && other.unit_id !== unit.id) throw new Error("This board serial already belongs to another unit. Preserve the attempt and correct the unit selection before sync.");
   await writer.update(orgId, unit.id, { serial_number: serial });
   await writer.mergeMetadata(orgId, unit.id, { production_unit_key: `${registered.product_id}:${serial}` });
   await trx.updateTable("digifab_test_units").set({ serial }).where("unit_kind", "=", unit.kind).where("unit_id", "=", unit.id).execute();
  }
  if (firmware_hash) await trx.updateTable("digifab_test_units").set({ details: { ...registered.details, firmware_hash } }).where("unit_kind", "=", unit.kind).where("unit_id", "=", unit.id).execute();
  await writer.mergeMetadata(orgId, unit.id, { production_status: history.status, last_test_run: latest?.id ?? null, last_test_attempt: latest?.attempt ?? 0, ...(latest?.result?.steps.some(s => s.firmware_hash) ? { firmware_hash: latest.result.steps.find(s => s.firmware_hash)!.firmware_hash } : {}), ...(written ? { serial_written: { address: written.address, memory: written.memory } } : {}) });
 });
}
/** What a probe step does to the board, as the Start card says it. */
function probeLine(step: Extract<ProductionStep, { kind: "probe" }>): string {
 const action = step.action;
 if (action.op === "write") return `Write ${action.value} to 0x${action.address.toString(16)} over ${step.tool}`;
 if (action.op === "reset") return `Reset the board${action.halt ? " and halt it" : ""} over ${step.tool}`;
 return `Run the board's test firmware over ${step.tool}`;
}
export async function productionMutation(db: Kysely<DigifabDB>, orgId: string, userId: string, operation: string, fields: unknown) {
 if (["save_plan", "save_jig", "mint_unit"].includes(operation) && !await platform().auth.userHasRole({ orgId, userId, minRole: "admin" })) throw new Error("An admin must edit plans, fixtures or unit numbering.");
 if (operation === "save_plan") { const input = z.object({ id: uuid.optional(), plan: z.unknown() }).strict().parse(fields), plan = validateProductionPlan(await pinProgramImages(orgId, input.plan)); for (const ref of [plan.product, plan.board_revision, plan.customer].filter(Boolean)) if (!await platform().entities.lookup(orgId, ref!.kind, ref!.id)) throw new Error("Choose a product, revision and customer in this workspace."); return saveProductionPlan(db, plan, input.id); }
 if (operation === "save_jig") return saveProductionJig(db, orgId, NewProductionJig.parse(fields));
 if (operation === "mint_unit") return mintProductionUnit(db, orgId, userId, NewProductionUnit.parse(fields));
 if (operation === "prepare") return prepareProductionStation(db, orgId, userId, fields);
 if (operation === "sync") return syncProductionAttempt(db, orgId, z.object({ id: uuid }).strict().parse(fields).id);
 if (operation === "run_fields") {
  // A person's own fields on an attempt; the trigger lets these alone change, never the evidence.
  const input = z.object({ run_id: uuid, metadata: z.record(z.unknown()) }).strict().parse(fields);
  const row = await db.selectFrom("digifab_test_runs").select(["id", "metadata"]).where("id", "=", input.run_id).executeTakeFirst();
  if (!row) throw new Error("Choose a test attempt in this workspace.");
  const metadata = { ...(row.metadata ?? {}), ...input.metadata };
  await db.updateTable("digifab_test_runs").set({ metadata }).where("id", "=", input.run_id).execute();
  return { id: input.run_id, metadata };
 }
 if (operation === "disposition") {
  const input = z.object({ run_id: uuid, status: z.enum(["reworked", "scrapped"]), notes: z.string().max(8000).default("") }).strict().parse(fields);
  const run = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", input.run_id).executeTakeFirstOrThrow();
  if (!run.result || run.result.status === "passed") throw new Error("Choose a failed or aborted finished attempt for rework or scrap.");
  const history = await productionUnitHistory(db, { kind: run.unit_kind, id: run.unit_id });
  if (history.runs[0]?.id !== run.id || history.status === "scrapped") throw new Error("Use the unit's latest failed attempt. Scrapped evidence stays on file.");
  const saved = await db.insertInto("digifab_test_dispositions").values({ ...input, operator_id: userId }).returningAll().executeTakeFirstOrThrow();
  await projectProductionUnit(db, orgId, history.unit); return saved;
 }
 throw new Error("Choose save_plan, save_jig, mint_unit, prepare, sync, run_fields or disposition.");
}
export async function productionControl(db: Kysely<DigifabDB>, orgId: string, operation: string, raw: unknown) {
 if (!["start", "abort", "answer"].includes(operation)) throw new Error("Choose Start, Abort or an operator answer.");
 const input = z.object({ id: uuid, confirmed: z.boolean().optional(), jig_id: uuid.nullable().optional(), step_id: z.string().max(80).optional(), value: z.union([z.number().finite(), z.string().max(200_000), z.boolean()]).optional(), photo: z.object({ filename: z.string().max(200), mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]), data_b64: z.string().max(2_800_000) }).strict().optional() }).strict().parse(raw);
 const row = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", input.id).executeTakeFirstOrThrow();
 if (!row.bridge_connection_id) throw new Error("Choose this attempt's bridge connection.");
 if (operation !== "abort" && row.finished_at) throw new Error("This attempt is finished. Retest as a new attempt.");
 if (operation === "start") {
  if (input.confirmed !== true && row.plan.steps.some(s => s.kind === "program" || s.kind === "script" || s.kind === "serial" && s.write !== undefined || s.kind === "instrument" && s.operation !== "measure")) throw new Error("Confirm the fixture and output settings before Start.");
  for (const alias of row.plan.controlled_instruments) if (!await configuredControl(orgId, row.plan.instruments[alias]!.connection_id)) throw new Error(`The workspace owner must enable control for ${alias}.`);
  if (row.jig_id && input.jig_id !== row.jig_id) throw new Error("Scan the jig saved for this attempt.");
 }
 return (await bridge(orgId, row.bridge_connection_id))(operation, input);
}
export const ProductionReportFilter = z.object({ product_id: uuid.optional(), customer_id: uuid.optional(), lot: z.string().max(160).optional() }).strict();
export async function productionReportRows(db: Kysely<DigifabDB>, raw: unknown) {
 const filter = ProductionReportFilter.parse(raw);
 let query = db.selectFrom("digifab_test_runs as r").innerJoin("digifab_test_units as u", join => join.onRef("u.unit_kind", "=", "r.unit_kind").onRef("u.unit_id", "=", "r.unit_id")).selectAll("r").where("r.finished_at", "is not", null);
 if (filter.product_id) query = query.where("u.product_id", "=", filter.product_id);
 if (filter.customer_id) query = query.where(sql<string>`u.details->'customer'->>'id'`, "=", filter.customer_id);
 if (filter.lot) query = query.where(sql<string>`u.details->>'lot'`, "=", filter.lot);
 const rows = await query.orderBy("r.prepared_at", "desc").limit(10_001).execute();
 if (rows.length > 10_000) throw new Error("Choose a smaller lot or product to report every attempt in this view.");
 return rows;
}
export async function exportProductionReport(db: Kysely<DigifabDB>, orgId: string, raw: unknown) {
 const input = z.object({ unit: ProductionUnitRef.optional(), filter: ProductionReportFilter.optional(), format: z.enum(["pdf", "json"]).default("pdf") }).strict().parse(raw);
 const rows = input.unit ? (await productionUnitHistory(db, input.unit)).runs.filter(r => r.result) : await productionReportRows(db, input.filter ?? {});
 if (!rows.length) throw new Error("Choose units with completed test attempts.");
 const units = await db.selectFrom("digifab_test_units").selectAll().where("unit_id", "in", rows.map(r => r.unit_id)).execute(), serials = Object.fromEntries(units.map(u => [u.unit_id, u.serial]));
 const bytes = input.format === "pdf" ? await productionCertificate(rows, serials) : Buffer.from(JSON.stringify({ units, runs: rows, statistics: productionStatistics(rows) }, null, 2));
 const file = await platform().files.write(orgId, bytes, { filename: `production-test.${input.format}`, mimeType: input.format === "pdf" ? "application/pdf" : "application/json" });
 if (!file) throw new Error("Enable Files to keep and share this test certificate.");
 return { file_id: file.fileId, units: units.length, attempts: rows.length };
}
function testRunEntity(row: Selectable<DigifabDB["digifab_test_runs"]>) {
 return { kind: "digifab:test-run", id: row.id, title: `${row.plan.name} · Attempt ${row.attempt}`, subtitle: row.result?.status ?? "Prepared", detailUrl: openRecordPath("digifab:test-run", row.id), fields: { ...(row.metadata ?? {}), plan_version: row.plan_version, plan_hash: row.plan_hash, status: row.result?.status ?? "prepared", result: row.result, unit_kind: row.unit_kind, unit_id: row.unit_id, operator_id: row.operator_id, station: row.station, jig_id: row.jig_id, jig_cycle: row.jig_cycle } };
}
let registered = false;
export function registerProductionTest() {
 if (registered) return; registered = true;
 const authorize = async (ctx: ActionInvokeContext) => { if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) throw new Error("A workspace member must use production test."); return ctx.userId; };
 for (const action of ["production-test", "production-control", "production-abort", "production-read"] as const) {
  platform().actions.registerHandler(`digifab.${action}`, async ctx => {
   try {
    const user = await authorize(ctx), db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>, args = ctx.args ?? {}, operation = String(args.operation ?? ""), fields = readJsonArg<Record<string, unknown>>(args, "fields") ?? {};
    if (action === "production-test") return { ok: true, result: operation === "export" ? await exportProductionReport(db, ctx.orgId, fields) : await productionMutation(db, ctx.orgId, user, operation, fields) };
    if (action === "production-control") return { ok: true, result: await productionControl(db, ctx.orgId, operation, fields) };
    if (action === "production-abort") return { ok: true, result: await productionControl(db, ctx.orgId, "abort", { id: args.id }) };
    if (operation === "artifact") { const file_id = uuid.parse(fields.file_id), file = await platform().files.read(ctx.orgId, file_id); if (!file) throw new Error("Choose a file in this workspace."); return {ok:true,result:{file_id,sha256:createHash("sha256").update(file.bytes).digest("hex")}}; }
    if (operation === "history") return { ok: true, result: await productionUnitHistory(db, ProductionUnitRef.parse(fields)) };
    if (operation === "report") return { ok: true, result: productionStatistics(await productionReportRows(db, fields)) };
    if (operation === "bridge") return { ok: true, result: await (await bridge(ctx.orgId, uuid.parse(fields.connection_id)))("read", {}) };
    return { ok: false, error: "Choose history, report, artifact or bridge." };
   } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Production test could not finish this action." }; }
  });
 }
 platform().actions.registerPlanner("digifab.production-control", async ctx => {
  const args = ctx.args ?? {}, fields = readJsonArg<Record<string, unknown>>(args, "fields") ?? {};
  try { const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>, row = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", uuid.parse(fields.id)).executeTakeFirstOrThrow(); return { title: `${args.operation === "answer" ? "Record an answer for" : "Start"} ${row.plan.name}`, lines: [`Exact version ${row.plan_version}, attempt ${row.attempt}`, `${countOf(row.plan.steps.length, "step")}; all declared supplies turn off at the end`, ...row.plan.steps.flatMap(s => s.kind === "program" ? [`Program firmware ${s.firmware.sha256}`] : s.kind === "probe" && stepChangesHardware(s) ? [probeLine(s)] : [])] }; } catch { return { error: "Choose an existing production attempt." }; }
 });
 platform().entities.registerResolver("digifab:test-run", async (orgId, id) => {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>, row = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? testRunEntity(row) : null;
 });
 platform().entities.registerListResolver("digifab:test-run", async (orgId, query) => {
  const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
  let source = db.selectFrom("digifab_test_runs").selectAll().select(sql<string>`count(*) over()`.as("total_count"));
  const q = query.q?.trim();
  if (q) source = source.where(eb => eb.or([eb(sql<string>`plan->>'name'`, "ilike", `%${likeEscape(q)}%`), eb("station", "ilike", `%${likeEscape(q)}%`)]));
  const rows = await source.orderBy("prepared_at", "desc").orderBy("id", "desc").limit(Math.min(query.limit || 50, 200)).offset(query.offset || 0).execute();
  return { items: rows.map(testRunEntity), total: Number(rows[0]?.total_count ?? 0) };
 });
}
