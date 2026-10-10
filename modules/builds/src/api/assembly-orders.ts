import { Router } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { checkBoardStock } from "../board-revision.js";
import { tenantDb, tenantContext, sessionUser, type BuildsDB } from "../db.js";
import { readBoardStock, revision } from "./board-revisions.js";
import { asyncHandler } from "./util.js";
export interface AssemblyKitLine { part_id: string; kind: string; qty: number; placements: number; role: "component" | "blank"; lot_code?: string | null; allocation_id?: string }
export interface AssemblyOrder {
  finish_intent?: { run_id: string; source_id: string; input_kind: string; input_id: string; output_kind: string; output_id: string; accepted: number; rejected: number; by: string | null };
  inspection_machine?: { kind: string; id: string };
  finished?: { run_id: string; output_kind: string; output_id: string; accepted: number; rejected: number; by: string | null; at: string };
  trace?: ReturnType<typeof import("../assembly-inspection.js").assemblyTrace>;
  request_key: string; state: "draft" | "kitted" | "released" | "pasted" | "placing" | "placed" | "reflowed" | "tested" | "cancelled";
  reflow?: import("./reflow.js").AssemblyReflow; reflow_history?: import("./reflow.js").AssemblyReflow[];
  kit_plan?: AssemblyKitLine[]; released_by?: string | null; released_at?: string;
  paste_intent?: NonNullable<AssemblyOrder["paste"]> & { handling_revision: number; applied_by: string | null };
  paste?: { part_id: string; kind: string; lot_code: string; amount_ml: number; applied_at: string; stencil_id: string; source: string };
  placement?: { machine_kind: string; machine_id: string; profile: import("../placement-program.js").PlacementProfile; feeders: import("../placement-program.js").FeederAssignment[]; signature: string; verified: Record<string, { part_id: string; station_id: string; at: string }>; sides: Partial<Record<"top" | "bottom", { started_at: string; operator_id: string | null; station_id: string; completed_at?: string }>>; output_kind: string; output_id: string };
}
const Create = z.object({ build_id: z.string().uuid(), boards: z.number().int().positive().max(1_000_000), request_key: z.string().trim().min(1).max(160), notes: z.string().max(2000).optional() });
const Change = z.object({ order_id: z.string().uuid(), operation: z.enum(["kit", "release", "cancel"]) });
export async function inventoryKit(ctx: ActionInvokeContext, args: Record<string, unknown>) {
  const result = normaliseActionResult(await platform().actions.invoke("inventory:assembly-kit", { ...ctx, entity: undefined, args: { ...args, target_kind: "builds:work-order" } }), "inventory.assembly-kit");
  if (!result.ok) throw new ActionRefusal(typeof result.error === "string" ? result.error : "The kit did not change.");
  return result.data as { ready: boolean; reason: string | null; lines: Array<{ id: string; part_id: string; qty: string; status: string; context: { lot_code?: string | null } }>; stock: Array<{ id: string; name: string; lot_code: string | null; location_id: string | null }> };
}
export async function assemblyOrder(db: Kysely<BuildsDB>, id: string) {
  const row = await db.selectFrom("builds_planned").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row?.assembly) throw new ActionRefusal("Choose an assembly work order.");
  return row as typeof row & { assembly: AssemblyOrder };
}
export async function assemblyOrderView(ctx: ActionInvokeContext, id: string) {
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
  const row = await assemblyOrder(db, id);
  const kit = row.assembly.state === "draft" || row.assembly.state === "cancelled" ? null : await inventoryKit(ctx, { target_id: id, operation: "check" });
  const lines = await Promise.all((row.assembly.kit_plan ?? []).map(async line => {
    const part = await platform().entities.lookup(ctx.orgId, line.kind, line.part_id, { userId: ctx.userId ?? undefined });
    return { ...line, name: part?.title ?? "Unavailable stock", location: String(part?.fields.location_name ?? "Unassigned"), lot_code: line.lot_code ?? null };
  }));
  return { ...row, qty: Number(row.qty), kit: { ready: kit?.ready ?? false, reason: kit?.reason ?? null, lines: lines.sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name)) } };
}
async function listOrders(db: Kysely<BuildsDB>, buildId: string) {
  const items = await db.selectFrom("builds_planned").select(["id", "qty", "assembly", "status"]).where("build_id", "=", buildId).where("assembly", "is not", null).orderBy("created_at", "desc").execute();
  return { items };
}
export function registerAssemblyOrderActions() {
  platform().actions.registerHandler("builds.assembly-orders", async ctx => {
    const p = z.object({ build_id: z.string().uuid() }).parse(ctx.args);
    return { ok: true, data: await listOrders(await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>, p.build_id) };
  });
  platform().actions.registerHandler("builds.create-assembly-order", async ctx => {
    const p = Create.parse(ctx.args);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    await revision(db, p.build_id);
    const saved = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`assembly-order:${p.request_key}`}, 0))`.execute(trx);
      const old = await trx.selectFrom("builds_planned").selectAll().where(sql<boolean>`assembly->>'request_key' = ${p.request_key}`).executeTakeFirst();
      if (old) {
        if (old.build_id !== p.build_id || Number(old.qty) !== p.boards || (old.notes ?? "") !== (p.notes ?? "")) throw new ActionRefusal("This work order key already describes a different order.");
        return { row: old, created: false };
      }
      const row = await trx.insertInto("builds_planned").values({ build_id: p.build_id, qty: String(p.boards), due_date: null, notes: p.notes ?? null, resource_label: null, source_kind: null, source_id: null, assembly: { request_key: p.request_key, state: "draft" } }).returningAll().executeTakeFirstOrThrow();
      return { row, created: true };
    });
    if (saved.created) await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "work-order_created", ref: { module: "builds", entityType: "work-order", entityId: saved.row.id }, diff: { qty: p.boards } });
    if (saved.created) await platform().events.emit("builds.planned.created", { orgId: ctx.orgId, plannedId: saved.row.id, buildId: p.build_id });
    return { ok: true, changed: saved.created, data: { order_id: saved.row.id } };
  });
  platform().actions.registerHandler("builds.assembly-order", async ctx => ({ ok: true, data: await assemblyOrderView(ctx, z.object({ order_id: z.string().uuid() }).parse(ctx.args).order_id) }));
  platform().actions.registerHandler("builds.change-assembly-order", async ctx => {
    const p = Change.parse(ctx.args);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    if (p.operation === "kit") await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      if (!row?.assembly) throw new ActionRefusal("Choose an assembly work order.");
      if (row.assembly.state !== "draft" || row.assembly.kit_plan) return;
      const { spec } = await revision(trx, row.build_id);
      if (!spec.blank_part_id) throw new ActionRefusal("Track and receive this revision's blank boards first.");
      const checked = checkBoardStock(spec.bom, Number(row.qty), await readBoardStock(ctx, spec));
      if (!checked.ready) throw new ActionRefusal("The component stock is short or unusable. Check stock before kitting.");
      const lines: AssemblyKitLine[] = checked.lines.flatMap(l => l.picks.map(pick => ({ part_id: pick.part_id, kind: spec.package_kind, qty: pick.consume, placements: pick.placements, role: "component" as const })));
      lines.push({ part_id: spec.blank_part_id, kind: spec.blank_kind, qty: Number(row.qty), placements: 0, role: "blank" });
      await trx.updateTable("builds_planned").set({ assembly: { ...row.assembly, kit_plan: lines }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      if (!row?.assembly) throw new ActionRefusal("Choose an assembly work order.");
      const a = row.assembly;
      if (p.operation === "cancel") {
        if (a.state === "cancelled") return;
        if (!["draft", "kitted", "released"].includes(a.state)) throw new ActionRefusal("This order has already used material and cannot be cancelled.");
        const kit = await inventoryKit(ctx, { target_id: row.id, operation: "check" });
        if (kit.lines.length) await inventoryKit(ctx, { target_id: row.id, operation: "release" });
        await trx.updateTable("builds_planned").set({ status: "cancelled", assembly: { ...a, state: "cancelled" }, updated_at: new Date() }).where("id", "=", row.id).execute();
        return;
      }
      if (p.operation === "kit") {
        if (a.state === "kitted") return;
        if (a.state !== "draft" || !a.kit_plan) throw new ActionRefusal("Only a draft order can be kitted.");
        const reserved = await inventoryKit(ctx, { target_id: row.id, operation: "reserve", lines: a.kit_plan });
        const kit_plan = a.kit_plan.map(line => ({ ...line, lot_code: reserved.lines.find(p => p.part_id === line.part_id)?.context.lot_code ?? null, allocation_id: reserved.lines.find(p => p.part_id === line.part_id)?.id }));
        await trx.updateTable("builds_planned").set({ assembly: { ...a, kit_plan, state: "kitted" }, updated_at: new Date() }).where("id", "=", row.id).execute();
        return;
      }
      if (a.state !== "kitted" && a.state !== "released") throw new ActionRefusal("Kit this order before release.");
      await inventoryKit(ctx, { target_id: row.id, operation: "check", require_ready: true });
      if (a.state === "released") return;
      await trx.updateTable("builds_planned").set({ assembly: { ...a, state: "released", released_by: ctx.userId, released_at: new Date().toISOString() }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: { order_id: p.order_id } };
  });
}
export const assemblyOrdersRouter = Router({ mergeParams: true });
// AI-REACH: builds:assembly-order reads the same order and kit readiness.
assemblyOrdersRouter.get("/assembly-orders/:id", asyncHandler(async (req, res) => {
  res.json(await assemblyOrderView({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null, args: {}, entity: undefined, event: { name: null, payload: {}, actor: { user_id: sessionUser(req)?.id ?? null, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" } }, String(req.params.id)));
}));
// AI-REACH: builds:assembly-orders reads the same revision order list.
assemblyOrdersRouter.get("/assembly-orders", asyncHandler(async (req, res) => {
  const p = z.object({ build_id: z.string().uuid() }).parse(req.query);
  res.json(await listOrders(tenantDb(req), p.build_id));
}));

export type AssemblyOrderView = Awaited<ReturnType<typeof assemblyOrderView>>;
