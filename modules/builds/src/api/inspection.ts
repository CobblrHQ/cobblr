import { Router } from "express";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { checkInspection, inspectionSummary, assemblyTrace } from "../assembly-inspection.js";
import { assemblyOrder, assemblyOrderView } from "./assembly-orders.js";
import { invoke, operator } from "./placement.js";
import { revision } from "./board-revisions.js";
import { tenantContext, sessionUser, type BuildsDB } from "../db.js";
import { asyncHandler } from "./util.js";
const Order = z.object({ order_id: z.string().uuid() });
const Machine = Order.extend({ machine_kind: z.string().min(3), machine_id: z.string().uuid() });
const Station = Order.extend({ station_token: z.string().min(32).max(128) });
const Decision = Station.extend({ ordinal: z.number().int().positive(), revision: z.number().int().min(0), status: z.enum(["pass", "fail"]), front_file_id: z.string().uuid(), back_file_id: z.string().uuid(), defects: z.array(z.enum(["bridge", "tombstone", "missing", "polarity", "other"])).max(5), notes: z.string().trim().max(4000).default(""), serial_code: z.string().trim().max(160).nullable().default(null), confirmed_tested: z.literal(true) });
async function database(orgId: string) { return await platform().tenants.getDb(orgId) as Kysely<BuildsDB>; }
async function authorize(ctx: ActionInvokeContext, machine: { kind: string; id: string } | undefined, token: string) {
 await operator(ctx); if (!machine) throw new ActionRefusal("Choose the inspection bench on the work order first.");
 return platform().devices.authorizeAtStation(ctx.orgId, { machine_kind: machine.kind, machine_id: machine.id, purpose: "inspection", token });
}
export async function inspectionView(orgId: string, id: string) {
 const db = await database(orgId), row = await db.selectFrom("builds_inspections").selectAll().where("id", "=", id).executeTakeFirst();
 if (!row) throw new ActionRefusal("Choose an inspection record from this workspace.");
 const order = await assemblyOrder(db, row.order_id);
 return { ...row, build_id: order.build_id, finished: order.assembly.finished ?? null, trace: order.assembly.trace ?? assemblyTrace(order.assembly), reflow: order.assembly.reflow ?? null };
}
export async function inspectionResources(orgId: string, id: string, userId: string | null, ordinal?: number) {
 const db = await database(orgId), order = await assemblyOrder(db, id);
 let query = db.selectFrom("builds_inspections").selectAll().where("order_id", "=", id);
 if (ordinal !== undefined) query = query.where("ordinal", "=", ordinal);
 const counts = await db.selectFrom("builds_inspections").select([sql<string>`count(*)`.as("inspected"), sql<string>`count(*) filter (where status = 'pass')`.as("accepted")]).where("order_id", "=", id).executeTakeFirstOrThrow();
 return { machines: (await platform().devices.machineRecords(orgId, userId)).map(({ kind, record }) => ({ kind, id: record.id, name: record.title })), items: await query.orderBy("ordinal").limit(200).execute(), counts: { inspected: Number(counts.inspected), accepted: Number(counts.accepted), total: Number(order.qty) }, machine: order.assembly.inspection_machine ?? null, finished: order.assembly.finished ?? null, trace: order.assembly.trace ?? (order.assembly.reflow ? assemblyTrace(order.assembly) : null) };
}
export async function assemblyRecall(orgId: string, code: string) {
 const db = await database(orgId);
 const rows = await db.selectFrom("builds_run_inputs as input").innerJoin("builds_runs as run", "run.id", "input.run_id").innerJoin("builds_planned as order", join => join.on(sql<boolean>`"order".assembly->'finished'->>'run_id' = run.id::text`)).select(["order.id", "order.build_id", "order.assembly", "run.id as run_id"]).distinct().where(eb => eb.or([eb("input.lot_code", "=", code), eb("input.part_id", "=", /^[a-f0-9-]{36}$/i.test(code) ? code : "00000000-0000-0000-0000-000000000000")])).orderBy("order.id").limit(200).execute();
 return { code, items: rows.map(row => ({ order_id: row.id, build_id: row.build_id, run_id: row.run_id, finished: row.assembly?.finished, trace: row.assembly?.trace })) };
}
export function registerInspectionActions() {
 platform().actions.registerHandler("builds.update-inspection-metadata", async ctx => { await operator(ctx); const p = z.object({ inspection_id: z.string().uuid(), metadata: z.record(z.unknown()) }).parse(ctx.args), db = await database(ctx.orgId); const row = await db.updateTable("builds_inspections").set({ metadata: sql<Record<string, unknown>>`metadata || ${JSON.stringify(p.metadata)}::jsonb` }).where("id", "=", p.inspection_id).returning("id").executeTakeFirst(); if (!row) throw new ActionRefusal("Choose an inspection from this workspace."); await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "updated", ref: { module: "builds", entityType: "inspection", entityId: row.id }, diff: { metadata: p.metadata } }); return { ok: true, changed: true }; });
 platform().actions.registerHandler("builds.inspection-resources", async ctx => { const p = Order.extend({ ordinal: z.number().int().positive().optional() }).parse(ctx.args); return { ok: true, data: await inspectionResources(ctx.orgId, p.order_id, ctx.userId, p.ordinal) }; });
 platform().actions.registerHandler("builds.inspection", async ctx => ({ ok: true, data: await inspectionView(ctx.orgId, z.object({ inspection_id: z.string().uuid() }).parse(ctx.args).inspection_id) }));
 platform().actions.registerHandler("builds.assembly-recall", async ctx => ({ ok: true, data: await assemblyRecall(ctx.orgId, z.object({ code: z.string().trim().min(1).max(160) }).parse(ctx.args).code) }));
 platform().actions.registerHandler("builds.prepare-inspection", async ctx => {
  await operator(ctx); const p = Machine.parse(ctx.args), db = await database(ctx.orgId);
  if (!await platform().devices.machineRecord(ctx.orgId, p.machine_kind, p.machine_id, ctx.userId)) throw new ActionRefusal("Choose an available native inspection bench.");
  await db.transaction().execute(async trx => { const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst(); if (!row?.assembly || row.assembly.state !== "reflowed" || row.assembly.finish_intent) throw new ActionRefusal("Complete reflow before preparing inspection. A finishing batch cannot change stations."); await trx.updateTable("builds_planned").set({ assembly: { ...row.assembly, inspection_machine: { kind: p.machine_kind, id: p.machine_id } }, updated_at: new Date() }).where("id", "=", row.id).execute(); });
  return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
 });
 platform().actions.registerHandler("builds.inspect-board", async ctx => {
  const p = Decision.parse(ctx.args), db = await database(ctx.orgId);
  const files = await platform().files.describe(ctx.orgId, [p.front_file_id, p.back_file_id]);
  if (files?.length !== 2 || files.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.mimeType))) throw new ActionRefusal("Keep front and back image files from this workspace.");
  let inspectionId: string;
  try { inspectionId = await db.transaction().execute(async trx => {
   const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
   if (!row?.assembly || row.assembly.state !== "reflowed" || row.assembly.finish_intent) throw new ActionRefusal("Inspect a reflowed batch before finishing it. Finished evidence cannot be replaced.");
   const station = await authorize(ctx, row.assembly.inspection_machine, p.station_token);
   try { checkInspection(p, Number(row.qty), row.assembly.reflow?.report?.in_spec !== true); } catch (e) { throw new ActionRefusal((e as Error).message); }
   const old = await trx.selectFrom("builds_inspections").selectAll().where("order_id", "=", row.id).where("ordinal", "=", p.ordinal).executeTakeFirst();
   if ((old?.revision ?? 0) !== p.revision) throw new ActionRefusal("This board was inspected on another screen. Reload its latest evidence before changing it.");
   const duplicate = await trx.selectFrom("builds_inspections").select("id").where("order_id", "=", row.id).where("ordinal", "!=", p.ordinal).where(eb => eb.or([eb("front_file_id", "in", [p.front_file_id, p.back_file_id]), eb("back_file_id", "in", [p.front_file_id, p.back_file_id])])).executeTakeFirst();
   if (duplicate) throw new ActionRefusal("Those photos already identify another board in this batch. Keep this board's own front and back photos.");
   if (old?.status === "fail" && p.status === "pass" && p.notes.length < 10) throw new ActionRefusal("Record the completed rework and test before passing this board.");
   const values = { status: p.status, front_file_id: p.front_file_id, back_file_id: p.back_file_id, serial_code: p.serial_code || null, defects: sql<string>`${JSON.stringify([...new Set(p.defects)])}::jsonb`, notes: p.notes, inspected_by: ctx.userId, station_id: station.id, inspected_at: new Date() };
   // check-then-insert: the parent work order is locked for every inspection write; competing serial keys are refused by the 23505 handler.
   const saved = old ? await trx.updateTable("builds_inspections").set({ ...values, revision: old.revision + 1, history: sql<string>`${JSON.stringify([...old.history, { status: old.status, front_file_id: old.front_file_id, back_file_id: old.back_file_id, defects: old.defects, notes: old.notes, serial_code: old.serial_code, inspected_by: old.inspected_by, inspected_at: old.inspected_at, revision: old.revision }])}::jsonb` }).where("id", "=", old.id).returning("id").executeTakeFirstOrThrow() : await trx.insertInto("builds_inspections").values({ ...values, order_id: row.id, ordinal: p.ordinal }).returning("id").executeTakeFirstOrThrow();
   return saved.id;
  }); } catch (e) { if ((e as { code?: string }).code === "23505") throw new ActionRefusal("That serial already identifies another board in this workspace."); throw e; }
  for (const [role, fileId] of [["front", p.front_file_id], ["back", p.back_file_id]]) await platform().files.attach(ctx.orgId, { fileId: fileId!, source_module: "builds", source_type: "inspection", source_id: inspectionId, role: `${role}-v${p.revision + 1}` });
  await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: p.revision === 0 ? "inspection_created" : "updated", ref: { module: "builds", entityType: "inspection", entityId: inspectionId }, diff: { status: p.status, ordinal: p.ordinal } });
  return { ok: true, changed: true, data: await inspectionView(ctx.orgId, inspectionId) };
 });
 platform().actions.registerHandler("builds.finish-assembly", async ctx => {
  const p = Station.extend({ confirmed_all_boards: z.literal(true) }).parse(ctx.args), db = await database(ctx.orgId);
  const intent = await db.transaction().execute(async trx => {
   const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst(); const a = row?.assembly;
   if (!row || !a || !["reflowed", "tested"].includes(a.state) || !a.placement || !a.reflow || !a.paste) throw new ActionRefusal("Complete placement and reflow before finishing this batch.");
   await authorize(ctx, a.inspection_machine, p.station_token);
   if (a.finish_intent) return a.finish_intent;
   const inspected = await trx.selectFrom("builds_inspections").select(["ordinal", "status", "serial_code", "inspected_by"]).where("order_id", "=", row.id).execute();
   let summary; try { summary = inspectionSummary(inspected, Number(row.qty)); } catch (e) { throw new ActionRefusal((e as Error).message); }
   const { build, spec } = await revision(trx, row.build_id), kind = spec.tested_kind ?? "inventory:part", resolved = await platform().entities.resolveKind(ctx.orgId, kind), writer = await platform().entities.getWriter(ctx.orgId, kind);
   if (!writer || (await platform().entities.getKind(resolved.base))?.profile !== "stock-material") throw new ActionRefusal("Install the tested-board count collection first.");
   const source = `tested:${row.id}`;
   const output_id = await writer.findByKey?.(ctx.orgId, { field: "assembly_output_source", metadata: true }, source) ?? await writer.create(ctx.orgId, { instance: resolved.instance ?? resolved.base.split(":")[0], name: `${build.name}, assembled and tested batch ${row.id.slice(0, 8)}`, qty: 0, unit: "each", metadata: { assembly_output_source: source, board_revision_id: row.build_id, assembly_order_id: row.id, stage: "tested" } });
   const next = { run_id: randomUUID(), source_id: row.id, input_kind: a.placement.output_kind, input_id: a.placement.output_id, output_kind: kind, output_id, ...summary, by: ctx.userId };
   const trace = assemblyTrace(a);
   trace.operators = [...new Set([...trace.operators, ctx.userId, ...inspected.map(board => board.inspected_by)].filter((value): value is string => !!value))];
   await trx.updateTable("builds_planned").set({ assembly: { ...a, finish_intent: next, trace }, updated_at: new Date() }).where("id", "=", row.id).execute();
   return next;
  });
  await invoke(ctx, "inventory:finish-assembly-stock", { ...intent, source_kind: "builds:work-order" });
  const changed = await db.transaction().execute(async trx => {
   const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirstOrThrow(), a = row.assembly!;
   if (a.finished) return false;
   await trx.insertInto("builds_runs").values({ id: intent.run_id, build_id: row.build_id, qty_built: String(intent.accepted), consumed: { assembly_order_id: row.id, trace: a.trace }, built_by: ctx.userId }).execute();
   const trace = a.trace!;
   const inputs = [...trace.reels, ...trace.blanks].map(line => ({ run_id: intent.run_id, part_id: line.part_id, lot_code: line.lot_code ?? null, quantity: String(line.qty) }));
   inputs.push({ run_id: intent.run_id, part_id: trace.paste.part_id, lot_code: trace.paste.lot_code, quantity: String(trace.paste.amount_ml) });
   await trx.insertInto("builds_run_inputs").values(inputs).execute();
   const boards = await trx.selectFrom("builds_inspections").select(["serial_code"]).where("order_id", "=", row.id).where("status", "=", "pass").where("serial_code", "is not", null).execute();
   const outputs = boards.map(board => ({ run_id: intent.run_id, part_id: intent.output_id, serial_code: board.serial_code, quantity: "1" }));
   if (intent.accepted > boards.length) outputs.push({ run_id: intent.run_id, part_id: intent.output_id, serial_code: null, quantity: String(intent.accepted - boards.length) });
   if (outputs.length) await trx.insertInto("builds_run_outputs").values(outputs).execute();
   await trx.updateTable("builds_planned").set({ status: "done", assembly: { ...a, state: "tested", finished: { run_id: intent.run_id, output_kind: intent.output_kind, output_id: intent.output_id, accepted: intent.accepted, rejected: intent.rejected, by: ctx.userId, at: new Date().toISOString() } }, updated_at: new Date() }).where("id", "=", row.id).execute();
   return true;
  });
  if (changed) {
   const order = await assemblyOrder(db, p.order_id);
   await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "build_completed", ref: { module: "builds", entityType: "build", entityId: order.build_id }, diff: { accepted: intent.accepted, rejected: intent.rejected, order_id: p.order_id, run_id: intent.run_id } });
   await platform().events.emit("builds.planned.completed", { orgId: ctx.orgId, plannedId: p.order_id, buildId: order.build_id });
   await platform().events.emit("builds.build.completed", { orgId: ctx.orgId, buildId: order.build_id, qtyBuilt: intent.accepted, viaWire: false });
  }
  return { ok: true, changed, data: await assemblyOrderView(ctx, p.order_id) };
 });
}
export const inspectionRouter = Router({ mergeParams: true });
inspectionRouter.get("/assembly-orders/:id/inspection-resources", asyncHandler(async (req, res) => { res.json(await inspectionResources(tenantContext(req).org.id, String(req.params.id), sessionUser(req)?.id ?? null, req.query.ordinal ? z.coerce.number().int().positive().parse(req.query.ordinal) : undefined)); }));
inspectionRouter.get("/assembly-inspections/:id", asyncHandler(async (req, res) => { res.json(await inspectionView(tenantContext(req).org.id, String(req.params.id))); }));
inspectionRouter.get("/assembly-recall", asyncHandler(async (req, res) => { res.json(await assemblyRecall(tenantContext(req).org.id, z.string().trim().min(1).max(160).parse(req.query.code))); }));
