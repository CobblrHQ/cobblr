import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { BoardImport, importBoardFiles, checkBoardStock, distributorCart, type BoardFiles, type BoardStock } from "../board-revision.js";
import { tenantContext, tenantDb, sessionUser, type BuildsDB } from "../db.js";
import { asyncHandler } from "./util.js";

export interface BoardRevision extends BoardFiles {
  project_id: string; project_kind: string; revision: string; package_kind: string; blank_kind: string; stencil_kind: string;
  placed_kind?: string; tested_kind?: string;
  fingerprint: string; blank_part_id?: string; stencil_id?: string; stencil_style?: "framed" | "frameless";
}
const Project = z.object({ project_id: z.string().uuid(), project_kind: z.string().min(3).max(120) });
const Save = BoardImport.merge(Project).extend({ revision: z.string().trim().min(1).max(80), notes: z.string().max(8000).optional() });
const Check = z.object({ build_id: z.string().uuid(), boards: z.number().int().positive().max(1_000_000) });
const FabOrder = z.object({ build_id: z.string().uuid(), vendor: z.enum(["JLCPCB", "PCBWay", "OSH Park"]), qty: z.number().int().positive().max(1_000_000), request_key: z.string().min(1).max(160), source_file_id: z.string().uuid(), expected_arrival: z.string().optional(), tracking_number: z.string().max(160).optional() });
const Stencil = z.object({ build_id: z.string().uuid(), style: z.enum(["framed", "frameless"]), part_id: z.string().uuid().optional() });
const CircuitConfig = z.object({ package_kind: z.string().min(3), blank_kind: z.string().min(3), stencil_kind: z.string().min(3), placed_kind: z.string().min(3).optional(), tested_kind: z.string().min(3).optional() });
const specOf = (metadata: unknown): BoardRevision | null => (metadata as { assembly?: BoardRevision } | null)?.assembly ?? null;
export async function revision(db: Kysely<BuildsDB>, id: string) {
  const build = await db.selectFrom("builds_builds").selectAll().where("id", "=", id).executeTakeFirst();
  const spec = specOf(build?.metadata);
  if (!build || !spec) throw new ActionRefusal("Choose a board revision first.");
  return { build, spec };
}
async function projectView(ctx: Pick<ActionInvokeContext, "orgId" | "userId">, asked: z.infer<typeof Project>) {
  const project = await platform().entities.lookup(ctx.orgId, asked.project_kind, asked.project_id, { userId: ctx.userId ?? undefined });
  if (!project) throw new ActionRefusal("That board project is missing or unavailable.");
  const kind = await platform().entities.resolveKind(ctx.orgId, asked.project_kind);
  const instance = kind.instance ?? (typeof project.fields.instance === "string" ? project.fields.instance : null);
  const cfg = instance ? await platform().instances.configOf(ctx.orgId, instance) : null;
  const config = CircuitConfig.safeParse(cfg?.board_revisions);
  return { project, config: config.success ? config.data : null };
}
export async function readBoardStock(ctx: ActionInvokeContext, spec: BoardRevision) {
  const viewer = { userId: ctx.userId ?? undefined };
  const listed = await platform().entities.listAll(ctx.orgId, spec.package_kind, {}, viewer);
  if (!listed.complete) throw new ActionRefusal("This collection is too large for a complete stock check. Split it into smaller collections first.");
  const detailed = await platform().entities.lookupMany(ctx.orgId, listed.items.map(p => ({ kind: spec.package_kind, id: p.id })), viewer);
  const byId = new Map(detailed.map(p => [p.id, p]));
  return listed.items.filter(p => !p.retired).map(p => {
    const fields = { ...p.fields, ...byId.get(p.id)?.fields };
    const metadata = fields.metadata as Record<string, unknown> | undefined;
    const storage = fields.storage_readiness as { usable?: boolean; reason?: string | null } | undefined;
    const qty = Number(fields.qty), reserved = Number(p.fields.assigned_qty ?? 0), attrition = Number(metadata?.attrition_pct ?? 0);
    if (!Number.isSafeInteger(qty) || qty < 0 || !Number.isFinite(reserved) || reserved < 0 || !Number.isFinite(attrition) || attrition < 0 || attrition > 100) throw new ActionRefusal(`Check the count and attrition for ${p.title}.`);
    return { id: p.id, mpn: String(metadata?.mpn ?? ""), manufacturer: String(fields.manufacturer ?? ""), qty, reserved, attrition_pct: attrition,
      usable: storage?.usable === true, reason: storage?.reason ?? "Confirm package storage before use.", location: String(fields.location_name ?? "") || undefined } satisfies BoardStock;
  });
}
async function check(ctx: ActionInvokeContext, args: z.infer<typeof Check>) {
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
  const { spec } = await revision(db, args.build_id);
  return checkBoardStock(spec.bom, args.boards, await readBoardStock(ctx, spec));
}
async function stockRecord(ctx: ActionInvokeContext, db: Kysely<BuildsDB>, id: string, kind: "blank" | "stencil", style?: "framed" | "frameless", partId?: string) {
  return db.transaction().execute(async trx => {
    const build = await trx.selectFrom("builds_builds").selectAll().where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
    const spec = specOf(build.metadata);
    if (!spec) throw new ActionRefusal("Choose a board revision.");
    const field = kind === "blank" ? "blank_part_id" : "stencil_id";
    if (spec[field]) {
      if (partId && spec[field] !== partId || style && spec.stencil_style !== style) throw new ActionRefusal("This revision already has a different stencil. Make a new revision for the change.");
      return spec[field]!;
    }
    const targetKind = kind === "blank" ? spec.blank_kind : spec.stencil_kind;
    const stockKind = await platform().entities.resolveKind(ctx.orgId, targetKind);
    if (!stockKind.instance) throw new ActionRefusal("Choose a named stock collection for this board revision.");
    const writer = await platform().entities.getWriter(ctx.orgId, targetKind);
    if (!writer) throw new ActionRefusal("Install the board stock collection first.");
    const sourceKey = `${id}:${kind}`;
    let stockId = partId;
    if (stockId && !await platform().entities.lookup(ctx.orgId, targetKind, stockId, { userId: ctx.userId ?? undefined })) throw new ActionRefusal("Choose stock from this revision's stencil collection.");
    stockId ??= await writer.findByKey?.(ctx.orgId, { field: "board_revision_source", metadata: true }, sourceKey) ?? undefined;
    if (stockId && !await platform().entities.lookup(ctx.orgId, targetKind, stockId, { userId: ctx.userId ?? undefined })) stockId = undefined;
    stockId ??= await writer.create(ctx.orgId, { instance: stockKind.instance, name: `${build.name}, ${kind === "blank" ? "blank" : `${style} stencil`}`, qty: 0, unit: "each", metadata: { board_revision_source: sourceKey, board_revision_id: id, stage: kind, ...(style ? { stencil_style: style } : {}) } });
    const next = { ...spec, [field]: stockId, ...(style ? { stencil_style: style } : {}) };
    await trx.updateTable("builds_builds").set({ metadata: platform().db.mergeJsonb("metadata", { assembly: next }), updated_at: new Date() } as never).where("id", "=", id).execute();
    return stockId;
  });
}
async function boardProject(ctx: Pick<ActionInvokeContext, "orgId" | "userId">, args: z.infer<typeof Project>) {
    const { config } = await projectView(ctx, args);
    if (!config) return { enabled: false, revisions: [] };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    const rows = await db.selectFrom("builds_builds").select(["id", "name", "metadata"]).where(sql<boolean>`metadata->'assembly'->>'project_id' = ${args.project_id}`).orderBy("created_at", "asc").execute();
    return { enabled: true, revisions: rows.map(r => ({ id: r.id, name: r.name, revision: specOf(r.metadata)!.revision })) };
}
export function registerBoardRevisionActions() {
  platform().actions.registerHandler("builds.board-project", async ctx => {
    const args = Project.parse(ctx.args);
    return { ok: true, data: await boardProject(ctx, args) };
  });
  platform().actions.registerHandler("builds.save-board-revision", async ctx => {
    const p = Save.parse(ctx.args);
    const { project, config } = await projectView(ctx, p);
    if (!config) throw new ActionRefusal("This project collection has no board revision setup.");
    let files: BoardFiles;
    try { files = importBoardFiles(p); } catch (e) { throw new ActionRefusal(e instanceof Error ? e.message : "Check the board files."); }
    const fingerprint = createHash("sha256").update(JSON.stringify({ files, notes: p.notes ?? "" })).digest("hex");
    const spec: BoardRevision = { ...files, ...config, project_id: p.project_id, project_kind: p.project_kind, revision: p.revision, fingerprint };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    const saved = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`board-revision:${p.project_id}:${p.revision}`}, 0))`.execute(trx);
      const old = await trx.selectFrom("builds_builds").select(["id", "metadata"]).where(sql<boolean>`metadata->'assembly'->>'project_id' = ${p.project_id} and metadata->'assembly'->>'revision' = ${p.revision}`).executeTakeFirst();
      if (old) {
        if (specOf(old.metadata)?.fingerprint !== fingerprint) throw new ActionRefusal("That revision already has different files. Give the changed board a new revision name.");
        return { build_id: old.id, already_imported: true };
      }
      const build = await trx.insertInto("builds_builds").values({ name: `${project.title} rev ${p.revision}`, notes: p.notes ?? null, metadata: { assembly: spec } } as never).returning("id").executeTakeFirstOrThrow();
      return { build_id: build.id, already_imported: false };
    });
    for (const [role, text] of [["bom", p.bom], ["centroid", p.positions]] as const) {
      const file = await platform().files.write(ctx.orgId, Buffer.from(text), { filename: `${saved.build_id}-${role}.csv`, mimeType: "text/csv" });
      if (!file) throw new ActionRefusal("File storage is unavailable. Retry this import when it is ready.");
      await platform().files.attach(ctx.orgId, { fileId: file.fileId, source_module: "builds", source_type: "build", source_id: saved.build_id, role });
    }
    if (!saved.already_imported) {
      await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "build_created", ref: { module: "builds", entityType: "build", entityId: saved.build_id }, diff: { name: `${project.title} rev ${p.revision}` } });
      await platform().events.emit("builds.build.created", { orgId: ctx.orgId, buildId: saved.build_id });
    }
    return { ok: true, changed: !saved.already_imported, data: saved };
  });
  platform().actions.registerHandler("builds.check-board-stock", async ctx => ({ ok: true, data: await check(ctx, Check.parse(ctx.args)) }));
  platform().actions.registerHandler("builds.board-cart", async ctx => {
    const args = Check.extend({ distributor: z.enum(["digikey", "mouser", "lcsc"]) }).parse(ctx.args);
    const checked = await check(ctx, args);
    return { ok: true, data: { csv: distributorCart(args.distributor, checked.lines), filename: `${args.distributor}-board-shortage.csv`, lines: checked.lines.filter(l => l.short > 0).length, manual_upload: true } };
  });
  platform().actions.registerHandler("builds.order-blank-boards", async ctx => {
    const p = FabOrder.parse(ctx.args);
    const file = await platform().files.read(ctx.orgId, p.source_file_id);
    if (!file || file.bytes[0] !== 0x50 || file.bytes[1] !== 0x4b) throw new ActionRefusal("Upload the fabrication zip first.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    const { build } = await revision(db, p.build_id);
    const partId = await stockRecord(ctx, db, p.build_id, "blank");
    const result = normaliseActionResult(await platform().actions.invoke("purchases:plan-order", { ...ctx, entity: undefined,
      args: { request_key: p.request_key, vendor: p.vendor, lines: [{ part_id: partId, description: `${build.name}, blank`, qty: p.qty }], add_to_stock: true, source_file_id: p.source_file_id,
        ...(p.expected_arrival ? { expected_arrival: p.expected_arrival } : {}), ...(p.tracking_number ? { tracking_number: p.tracking_number } : {}), notes: `Fabrication for ${build.name}. Upload the attached files to the fab and place the order there.` } }), "purchases.plan-order");
    if (!result.ok) throw new ActionRefusal(typeof result.error === "string" ? result.error : "The fabrication purchase was not recorded.");
    await platform().files.attach(ctx.orgId, { fileId: p.source_file_id, source_module: "builds", source_type: "build", source_id: build.id, role: "fabrication" });
    return { ok: true, changed: result.changed, data: { ...(result.data as Record<string, unknown>), blank_part_id: partId } };
  });
  platform().actions.registerHandler("builds.link-board-stencil", async ctx => {
    const p = Stencil.parse(ctx.args);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
    const partId = await stockRecord(ctx, db, p.build_id, "stencil", p.style, p.part_id);
    return { ok: true, changed: true, data: { stencil_id: partId, style: p.style } };
  });
}
export const boardRevisionsRouter = Router({ mergeParams: true });
// AI-REACH: board revision data is the builds:build metadata and its check-board-stock action.
boardRevisionsRouter.get("/board-revisions/:id", asyncHandler(async (req, res) => {
  const { build, spec } = await revision(tenantDb(req), String(req.params.id));
  res.json({ id: build.id, name: build.name, notes: build.notes, ...spec, files: await platform().files.listAttachments(tenantContext(req).org.id, { source_module: "builds", source_type: "build", source_id: build.id }) });
}));

// AI-REACH: builds:board-project reads the same project revision list.
boardRevisionsRouter.get("/board-project", asyncHandler(async (req, res) => {
  res.json(await boardProject({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null }, Project.parse(req.query)));
}));
