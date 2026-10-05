import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionRefusal, platform, readJsonArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { buildPlacementProgram, PlacementProfileSchema, verifyFeederScan, type FeederAssignment } from "../placement-program.js";
import { placementCoverageText, openpnpObserverScripts } from "../openpnp-observer.js";
import { revision, readBoardStock } from "./board-revisions.js";
import { assemblyOrder, assemblyOrderView, inventoryKit } from "./assembly-orders.js";
import { tenantContext, sessionUser, type BuildsDB } from "../db.js";
import { asyncHandler } from "./util.js";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
const Machine = z.object({ machine_kind: z.string().min(3).max(120), machine_id: z.string().uuid() });
const OrderId = z.object({ order_id: z.string().uuid() });
const Configure = Machine.extend({ model: PlacementProfileSchema.shape.model, packages: PlacementProfileSchema.shape.packages, work_area_width_mm: PlacementProfileSchema.shape.work_area_width_mm, work_area_height_mm: PlacementProfileSchema.shape.work_area_height_mm });
const Prepare = OrderId.merge(Machine).extend({ geometry: PlacementProfileSchema.omit({ model: true, packages: true, work_area_width_mm: true, work_area_height_mm: true }), slots: z.record(z.string().min(1).max(80)) });
const Station = OrderId.extend({ station_token: z.string().min(32).max(128) });
const Scan = Station.extend({ slot: z.string().min(1).max(80), code: z.string().min(1).max(4000) });
const Step = Station.extend({ side: z.enum(["top", "bottom"]), source: z.enum(["manual", "openpnp"]), coverage_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), confirmed_all_boards: z.literal(true) });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function invoke<T>(ctx: ActionInvokeContext, actionId: string, args: Record<string, unknown>) {
  const out = normaliseActionResult(await platform().actions.invoke(actionId, { ...ctx, entity: undefined, args }), actionId);
  if (!out.ok) throw new ActionRefusal(typeof out.error === "string" ? out.error : "The material step did not complete.");
  return out.data as T;
}
async function machine(ctx: Pick<ActionInvokeContext, "orgId" | "userId">, p: z.infer<typeof Machine>) {
  const record = await platform().devices.machineRecord(ctx.orgId, p.machine_kind, p.machine_id, ctx.userId);
  if (!record || record.retired) throw new ActionRefusal("Choose an available pick-and-place machine.");
  return record;
}
export async function placementResources(ctx: Pick<ActionInvokeContext, "orgId" | "userId">) {
  const machines = (await platform().devices.machineRecords(ctx.orgId, ctx.userId)).map(({ kind, record }) => ({ id: record.id, kind, name: record.title, profile: (record.fields.metadata as Record<string, unknown> | undefined)?.assembly_placement ?? null }));
  const jars: Array<{ id: string; kind: string; name: string }> = [];
  for (const entry of await platform().entities.listScannableForOrg(ctx.orgId)) {
    const instance = entry.instance ?? entry.module;
    if (!(await platform().instances.configOf(ctx.orgId, instance))?.paste_tracking) continue;
    const parts = await platform().entities.listAll(ctx.orgId, entry.kind, {}, { userId: ctx.userId ?? undefined });
    if (!parts.complete) throw new ActionRefusal("Narrow the paste collection before preparing this job.");
    jars.push(...parts.items.filter(p => !p.retired && Number(p.fields.qty) > 0).map(p => ({ id: p.id, kind: entry.kind, name: p.title })));
  }
  return { machines, jars };
}
export async function placementProgram(ctx: Pick<ActionInvokeContext, "orgId" | "userId">, id: string) {
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
  const row = await assemblyOrder(db, id), placement = row.assembly.placement;
  if (!placement) throw new ActionRefusal("Prepare the placement program first.");
  const { spec } = await revision(db, row.build_id);
  const program = buildPlacementProgram(spec, Number(row.qty), placement.profile, placement.feeders);
  program.files = program.files.map(f => f.name.endsWith(".job.xml") ? { ...f, name: `${id}-${f.name}` } : f);
  if (placement.profile.model === "openpnp") program.files.push(...openpnpObserverScripts(placement.machine_kind, placement.machine_id));
  program.files.push({ name: "placement-manifest.json", content: JSON.stringify({ order_id: id, signature: placement.signature, boards: Number(row.qty), machine_kind: placement.machine_kind, machine_id: placement.machine_id, profile: placement.profile, feeders: placement.feeders }, null, 2) });
  return { ...program, signature: placement.signature };
}
export async function operator(ctx: ActionInvokeContext) {
  if (!ctx.userId || ctx.event.trigger_type !== "user-invoked" || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) throw new ActionRefusal("Sign in at the authorized station to record this step.");
}
export function registerPlacementActions() {
  platform().actions.registerHandler("builds.placement-resources", async ctx => ({ ok: true, data: await placementResources(ctx) }));
  platform().actions.registerHandler("builds.placement-program", async ctx => ({ ok: true, data: await placementProgram(ctx, OrderId.parse(ctx.args).order_id) }));
  platform().actions.registerHandler("builds.configure-placement-machine", async ctx => {
    await operator(ctx);
    const args = ctx.args ?? {};
    const p = Configure.parse({ ...args, packages: readJsonArg(args, "packages") });
    await machine(ctx, p);
    const saved = await platform().entities.mergeMetadata(ctx.orgId, p.machine_kind, p.machine_id, { assembly_placement: { model: p.model, packages: p.packages, work_area_width_mm: p.work_area_width_mm, work_area_height_mm: p.work_area_height_mm } });
    if (!saved) throw new ActionRefusal("The machine could not save its calibrations. Reload it before preparing a job.");
    return { ok: true, changed: true };
  });
  platform().actions.registerHandler("builds.prepare-placement", async ctx => {
    const args = ctx.args ?? {};
    const p = Prepare.parse({ ...args, geometry: readJsonArg(args, "geometry"), slots: readJsonArg(args, "slots") });
    const record = await machine(ctx, p);
    const saved = Configure.omit({ machine_kind: true, machine_id: true }).safeParse((record.fields.metadata as Record<string, unknown> | undefined)?.assembly_placement);
    if (!saved.success) throw new ActionRefusal("Save this machine's verified package calibrations first.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      if (!row?.assembly || !["released", "pasted"].includes(row.assembly.state)) throw new ActionRefusal("Release this kit before preparing placement. A started program cannot be changed.");
      const { build, spec } = await revision(trx, row.build_id);
      const stocks = await readBoardStock(ctx, spec);
      const feeders: FeederAssignment[] = [];
      for (const line of row.assembly.kit_plan ?? []) {
        if (line.role !== "component") continue;
        const stock = stocks.find(s => s.id === line.part_id);
        if (!stock) throw new ActionRefusal("A reserved reel is unavailable.");
        const old = feeders.find(f => f.part_id === line.part_id);
        if (old) { old.placements += line.placements; old.qty += line.qty; continue; }
        feeders.push({ part_id: line.part_id, mpn: stock.mpn, manufacturer: stock.manufacturer, slot: p.slots[line.part_id] ?? "", placements: line.placements, qty: line.qty, lot_code: line.lot_code ?? null });
      }
      const profile = { ...p.geometry, ...saved.data };
      let program;
      try { program = buildPlacementProgram(spec, Number(row.qty), profile, feeders); } catch (e) { throw new ActionRefusal((e as Error).message); }
      const signature = hash(JSON.stringify({ revision: spec.fingerprint, boards: Number(row.qty), profile, feeders }));
      if (row.assembly.placement?.signature === signature) return;
      const output_kind = spec.placed_kind ?? "inventory:part";
      const resolved = await platform().entities.resolveKind(ctx.orgId, output_kind);
      if ((await platform().entities.getKind(resolved.base))?.profile !== "stock-material") throw new ActionRefusal("Choose count stock for placed boards.");
      const writer = await platform().entities.getWriter(ctx.orgId, output_kind);
      if (!writer) throw new ActionRefusal("Install the placed-board stock collection first.");
      const source = `placed:${row.id}`;
      const output_id = row.assembly.placement?.output_id ?? await writer.findByKey?.(ctx.orgId, { field: "assembly_output_source", metadata: true }, source) ?? await writer.create(ctx.orgId, { instance: resolved.instance ?? resolved.base.split(":")[0], name: `${build.name}, placed batch ${row.id.slice(0, 8)}`, qty: 0, unit: "each", metadata: { assembly_output_source: source, board_revision_id: row.build_id, assembly_order_id: row.id, stage: "placed" } });
      await trx.updateTable("builds_planned").set({ assembly: { ...row.assembly, placement: { machine_kind: p.machine_kind, machine_id: p.machine_id, profile: program.profile, feeders, signature, verified: {}, sides: {}, output_kind, output_id } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await placementProgram(ctx, p.order_id) };
  });
  platform().actions.registerHandler("builds.verify-feeder", async ctx => {
    await operator(ctx);
    const p = Scan.parse(ctx.args), db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      const a = row?.assembly, placement = a?.placement;
      if (!row || !a || !placement || !["released", "pasted", "placing"].includes(a.state)) throw new ActionRefusal("Choose a prepared placement job.");
      const station = await platform().devices.authorizeAtStation(ctx.orgId, { ...placement, purpose: "placement", token: p.station_token });
      const resolved = await platform().resolvables.resolve(ctx.orgId, p.code, { surface: "scan", source: "typed" });
      if (resolved.outcome !== "resolved" || resolved.candidate.provider_id !== "minted-token") throw new ActionRefusal("Scan a reel's Cobblr QR label from this workspace.");
      let feeder;
      try { feeder = verifyFeederScan(placement.feeders, p.slot, resolved.candidate.entity_id); } catch (e) { throw new ActionRefusal((e as Error).message); }
      await inventoryKit(ctx, { target_id: row.id, operation: "check", require_ready: true });
      await trx.updateTable("builds_planned").set({ assembly: { ...a, placement: { ...placement, verified: { ...placement.verified, [p.slot]: { part_id: feeder.part_id, station_id: station.id, at: new Date().toISOString() } } } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
  for (const operation of ["start", "finish"] as const) platform().actions.registerHandler(`builds.${operation}-placement`, async ctx => {
    await operator(ctx);
    const p = Step.parse(ctx.args), db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    await db.transaction().execute(async trx => {
      const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
      const a = row?.assembly, placement = a?.placement;
      if (!row || !a || !placement || !a.paste || !["pasted", "placing", "placed", "reflowed", "tested"].includes(a.state)) throw new ActionRefusal("Record usable paste and prepare this placement job first.");
      const station = await platform().devices.authorizeAtStation(ctx.orgId, { ...placement, purpose: "placement", token: p.station_token });
      const { spec } = await revision(trx, row.build_id);
      const program = buildPlacementProgram(spec, Number(row.qty), placement.profile, placement.feeders);
      const requiredSides = [...new Set(program.placements.map(place => place.side))];
      if (!requiredSides.includes(p.side)) throw new ActionRefusal("This job has no placements on that side.");
      if (p.source === "openpnp" && (placement.profile.model !== "openpnp" || p.coverage_hash !== hash(placementCoverageText(program.placements, p.side, program.profile)))) throw new ActionRefusal("The OpenPnP job is incomplete or differs from the exported placements. Check enabled boards, references, parts and coordinates.");
      const side = placement.sides[p.side];
      if (operation === "finish" && side?.completed_at) return;
      if (operation === "start" && side?.started_at) throw new ActionRefusal("This side has already started. Continue the existing run instead of starting it again.");
      if (a.state === "placed") throw new ActionRefusal("This work order has already finished placement.");
      if (placement.feeders.some(feeder => { const verified = placement.verified[feeder.slot]; return !verified || verified.part_id !== feeder.part_id || verified.station_id !== station.id; })) throw new ActionRefusal("Scan the correct reel at every feeder slot on this station before Start.");
      if (operation === "start") {
        await inventoryKit(ctx, { target_id: row.id, operation: "check", require_ready: true });
        const paste = await invoke<{ usable: boolean; reason: string | null }>(ctx, "inventory:paste-readiness", { partId: a.paste.part_id });
        if (!paste.usable) throw new ActionRefusal(paste.reason ?? "Check paste handling before Start.");
        const sides = { ...placement.sides, [p.side]: { started_at: new Date().toISOString(), operator_id: ctx.userId, station_id: station.id } };
        await trx.updateTable("builds_planned").set({ assembly: { ...a, state: "placing", placement: { ...placement, sides } }, updated_at: new Date() }).where("id", "=", row.id).execute();
        return;
      }
      if (!side?.started_at || side.station_id !== station.id) throw new ActionRefusal("Start this side at the same station before recording completion.");
      const sides = { ...placement.sides, [p.side]: { ...side, completed_at: new Date().toISOString() } };
      const complete = requiredSides.every(s => !!sides[s]?.completed_at);
      if (complete) await inventoryKit(ctx, { target_id: row.id, operation: "consume", confirmed_placed: true, output: { kind: placement.output_kind, part_id: placement.output_id, qty: Number(row.qty) } });
      await trx.updateTable("builds_planned").set({ assembly: { ...a, state: complete ? "placed" : "placing", placement: { ...placement, sides } }, updated_at: new Date() }).where("id", "=", row.id).execute();
    });
    return { ok: true, changed: true, data: await assemblyOrderView(ctx, p.order_id) };
  });
}
const readerContext = (req: import("express").Request) => ({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null });
export const placementRouter = Router({ mergeParams: true });
// AI-REACH: builds:placement-resources reads the same machines and paste jars.
placementRouter.get("/placement-resources", asyncHandler(async (req, res) => { res.json(await placementResources(readerContext(req))); }));
// AI-REACH: builds:placement-program exports the same program files.
placementRouter.get("/assembly-orders/:id/program", asyncHandler(async (req, res) => { res.json(await placementProgram(readerContext(req), String(req.params.id))); }));
