import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { TelemetrySchema } from "../kilns/model.js";
import { planResinPrint, readLoadedResinStock, resinStationKey } from "../resin-stock.js";
import { reservedResin } from "../resin-prints.js";
import { sql } from "kysely";
import { libraryForJob } from "../laser-plans.js";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { cncStationStock } from "../cnc-stock.js";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { authorizeLaserStart, stationTokenHash } from "../laser-station.js";
import { ReviewRequired } from "../drivers/job-review.js";
import { LaserMaterialSchema, materialFromFields } from "../laser-material.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

import { machineStationsRouter } from "./machine-stations.js";
import { familyOfStationKind } from "../core/families.js";

export const stationsRouter = Router({ mergeParams: true });
stationsRouter.use("/machines", machineStationsRouter);
const Machine = z.object({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200) });

type StationKind = "laser" | "print" | "cutter" | "resin" | "kiln" | "cnc" | "embroidery" | "large-format";
const machineKinds: Readonly<Record<string, StationKind>> = {
  laser: "laser", lasercutter: "laser", print: "print", printer: "print", "3dprinter": "print",
  cutter: "cutter", vinylcutter: "cutter", resin: "resin", resinprinter: "resin", kiln: "kiln",
  cnc: "cnc", cncmachine: "cnc", embroidery: "embroidery", embroiderymachine: "embroidery",
  largeformat: "large-format", largeformatprinter: "large-format",
};
function machineStationKind(type: string): StationKind | null {
  const key = type.toLowerCase().replace(/[\s_-]/g, "");
  return Object.hasOwn(machineKinds, key) ? machineKinds[key]! : null;
}

// AI-REACH: exempt station setup requires the owner at the machine, never an assistant or a wire.
stationsRouter.post("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = Machine.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const orgId = tenantContext(req).org.id;
  const db = tenantDb(req);
  const driver = await buildDriverById(db, orgId, parsed.data.connection_id);
  const devices = await driver?.listDevices();
  const device = devices?.find(d => d.id === parsed.data.device_id);
  const family = familyOfStationKind(device?.station_kind);
  if (family && !(await platform().parts.isOn(orgId, "digifab", family.part))) return void res.status(409).json({ error: { code: "part_not_enabled", module: "digifab", part: family.part, message: "This kind of machine is turned off in this workspace." } });
  if (!device || (!await driver?.jobReviewRequired?.() && !TelemetrySchema.safeParse(device.raw?.kiln).success && !family)) return void res.status(409).json({ error: { code: "not_station_machine", message: "Choose a connected machine that starts at a station." } });
  const token = randomBytes(32).toString("base64url");
  const row = await db.insertInto("digifab_stations").values({ connection_id: parsed.data.connection_id, remote_device_id: device.id, label: device.name, token_hash: stationTokenHash(token), revoked_at: null }).returning(["id", "label"]).executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId: sessionUser(req)?.id ?? null, action: "station_created", ref: { module: "digifab", entityType: "station", entityId: row.id }, diff: { label: row.label } });
  res.status(201).json({ ...row, token });
}));

stationsRouter.get("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  res.json({ items: await tenantDb(req).selectFrom("digifab_stations").select(["id", "label", "connection_id", "remote_device_id", "purpose", "machine_kind", "machine_id", "created_at", "revoked_at"]).orderBy("created_at", "desc").execute() });
}));

/** Take a station screen's Start permission away: the page's Revoke and the
 *  assistant's (#5091) are this one call. Revoking only removes access, so an
 *  owner may ask for it anywhere; minting or showing a credential stays the
 *  page's alone. A station is named by its id or by its label. */
export async function revokeStation(db: ReturnType<typeof tenantDb>, orgId: string, userId: string | null, said: string): Promise<{ id: string; label: string } | { error: string }> {
  const live = await db.selectFrom("digifab_stations").select(["id", "label"]).where("revoked_at", "is", null).execute();
  const want = said.trim().toLowerCase();
  const hits = live.filter((s) => s.id === said || (s.label ?? "").trim().toLowerCase() === want);
  if (!hits.length) return { error: `No station called "${said}" can start jobs now.` };
  if (hits.length > 1) return { error: `More than one station is called "${said}". Say which by its id.` };
  const station = hits[0]!;
  await db.updateTable("digifab_stations").set({ revoked_at: new Date() }).where("id", "=", station.id).execute();
  await platform().activity.log({ orgId, userId, action: "station_revoked", ref: { module: "digifab", entityType: "station", entityId: station.id } });
  return { id: station.id, label: station.label ?? "the station" };
}

// AI-ACTION: digifab:revoke-station
stationsRouter.delete("/:id", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
  if (!(await requireCapability(req, res, "digifab:revoke-station"))) return;
  await revokeStation(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.params.id!);
  res.json({ ok: true });
}));

stationsRouter.get("/:connectionId/:deviceId", asyncHandler(async (req, res) => {
  const benchDriver=await buildDriverById(tenantDb(req),tenantContext(req).org.id,req.params.connectionId!);
  if(benchDriver?.benchInstrument===true){
    if(!requireRole(req,res,"owner","admin","member"))return;
    const linked=await tenantDb(req).selectFrom("digifab_device_links").select("machine_id").where("connection_id","=",req.params.connectionId!).where("remote_device_id","=",req.params.deviceId!).executeTakeFirst();
    return void res.json({kind:"bench",screen_kind:"bench",machine_id:linked?.machine_id || null,job:null,library:null,attention:null,sheets:[]});
  }
  if (!requireRole(req, res, "owner", "admin")) return;
  const orgId = tenantContext(req).org.id;
  const db = tenantDb(req);
  const connection = req.params.connectionId!;
  const device = req.params.deviceId!;
  const jobs = await db.selectFrom("digifab_jobs").selectAll().where("connection_id", "=", connection).where("target_device", "=", device).where("status", "in", ["queued", "sent", "printing", "paused"]).orderBy("priority", "desc").orderBy("created_at", "asc").orderBy(sql<number>`coalesce((laser_layout ->> 'sheet_index')::int, 0)`, "asc").orderBy("id", "asc").execute();
  const attention = await db.selectFrom("digifab_device_attention").selectAll().where("connection_id", "=", connection).where("remote_device_id", "=", device).executeTakeFirst();
  const driver = await buildDriverById(db, orgId, connection);
  const link = await db.selectFrom("digifab_device_links").select("machine_id").where("connection_id", "=", connection).where("remote_device_id", "=", device).executeTakeFirst();
  const machine = link?.machine_id ? await platform().entities.lookup(orgId, "machines:machine", link.machine_id) : null;
  const type = typeof machine?.fields.type === "string" ? machine.fields.type.trim() : "";
  const processKind = driver?.printProcess === "resin" || driver?.printProcess === "large-format" ? driver.printProcess : null;
  // Known print processes keep the station and Stop reachable while the bridge is disconnected.
  const remote = processKind ? undefined : (await driver?.listDevices())?.find(d => d.id === device);
  // A production test station is a bridge device of its own; it is read from the same device list, never a second call.
  if (remote?.station_kind === "production-test") return void res.json({ kind: "production-test", screen_kind: "production-test", job: null, library: null, attention: null, sheets: [] });
  const reviewKind = processKind ?? await driver?.jobReviewKind?.();
  const reviewRequired = !!processKind || !!await driver?.jobReviewRequired?.();
  // Bridges without review support may still return a default laser review kind.
  const driverKind = processKind ?? remote?.station_kind ?? (reviewKind === "laser" && !reviewRequired ? null : reviewKind);
  const machineKind = machineStationKind(type);
  const kind = machineKind === "print" && processKind ? processKind : machineKind ?? driverKind ?? null;
  const reviewedKind = processKind ?? reviewKind;
  const screen_kind = reviewRequired && kind === reviewedKind ? kind : null;
  // A CNC job keeps its station, and Stop, while the bridge is away, the way a
  // known print process does; a finished one stays on screen until its outcome
  // is answered.
  const finished = attention?.job_id ? await db.selectFrom("digifab_jobs").selectAll().where("id", "=", attention.job_id).where("connection_id", "=", connection).where("target_device", "=", device).executeTakeFirst() : null;
  const cnc = screen_kind === "cnc" || ((kind === "cnc" || kind === null) && (!!finished?.cnc_setup || jobs.some(j => !!j.cnc_setup)));
  const job = (cnc ? finished : null) ?? jobs.find(j => j.status !== "queued") ?? jobs[0] ?? null;
  const library = job ? await libraryForJob(db, job) : null;
  if (cnc) return void res.json({ kind: "cnc", screen_kind: "cnc", job, library: library ?? null, attention: attention ?? null, sheets: [], cncStock: await cncStationStock(orgId, typeof req.query.q === "string" ? req.query.q : undefined) });
  if (!screen_kind) return void res.json({ kind, screen_kind, job, library: library ?? null, attention: attention ?? null, sheets: [] });
  if (kind === "cutter") return void res.json({ kind, screen_kind, job, library: library ?? null, attention: attention ?? null, sheets: [] });
  if (kind === "resin") {
    let loaded: Awaited<ReturnType<typeof readLoadedResinStock>> = [];
    let canStart = false, warning = "";
    try {
      loaded = await readLoadedResinStock(orgId, connection, device);
      const plan = planResinPrint(library?.metadata ?? {}, loaded, await reservedResin(db, job?.id));
      canStart = plan.canStart && job?.status === "queued" && !job.send_token && !job.remote_job_id; warning = job ? plan.warning : "";
    } catch (error) { warning = error instanceof Error ? error.message : "Check the loaded resin stock."; }
    const postprocess = await db.selectFrom("digifab_resin_prints as p").innerJoin("digifab_jobs as j", "j.id", "p.job_id")
      .select(["p.job_id", "p.wash_done", "p.cure_done", "j.file_ref", "j.metadata"])
      .where("p.connection_id", "=", connection).where("p.device_id", "=", device).where("p.phase", "=", "settled").where("j.outcome", "=", "good")
      .where(eb => eb.or([eb("p.wash_done", "=", false), eb("p.cure_done", "=", false)])).orderBy("p.created_at", "asc").limit(50).execute();
    const accounting = attention?.job_id ? await db.selectFrom("digifab_resin_prints").select("stock_error").where("job_id", "=", attention.job_id).executeTakeFirst() : null;
    return void res.json({ kind: "resin", screen_kind, job, library: library ?? null, attention: attention ?? null, sheets: [], resin: { station: resinStationKey(connection, device), loaded, canStart, warning, stockError: accounting?.stock_error ?? null, postprocess } });
  }
  if (kind !== "laser") return void res.json({ kind, screen_kind, job, library: library ?? null, attention: attention ?? null, sheets: [] });
  const stockKind = "inventory:part";
  const stockModule = stockKind.split(":")[0];
  const inventories = (await platform().instances.list(orgId)).filter(i => i.module_name === stockModule);
  const kinds = [...new Set(["inventory:part", ...inventories.map(i => i.is_default ? "inventory:part" : `${i.instance_name}:item`)])];
  const lists = await Promise.all(kinds.map(kind => platform().entities.list(orgId, kind, { q: typeof req.query.q === "string" ? req.query.q : undefined, limit: 100 })));
  const sheets = { items: lists.flatMap(l => l.items) };
  res.json({ kind, screen_kind, job, library: library ?? null, attention: attention ?? null, sheets: sheets.items.filter(s => !s.retired && Number(s.fields.qty ?? 0) > 0).map(s => ({ id: s.id, name: s.title, material: materialFromFields(s.fields) })) });
}));

const Sheet = z.object({ part_id: z.string().uuid(), laser_sheet: LaserMaterialSchema });
const Confirm = z.object({ job_id: z.string().uuid(), sheet_id: z.string().uuid(), station_token: z.string().min(32).max(128) });
// AI-REACH: exempt confirms the sheet physically loaded at a laser station, with that screen's credential.
stationsRouter.post("/:connectionId/:deviceId/confirm", asyncHandler(async (req, res) => {
  // The admin tier, or an operator: confirming the sheet loaded at the station (#6672).
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  const body = Confirm.safeParse(req.body);
  if (!body.success) return badBody(res, body.error);
  const orgId = tenantContext(req).org.id;
  const db = tenantDb(req);
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", body.data.job_id).where("connection_id", "=", req.params.connectionId!).where("target_device", "=", req.params.deviceId!).where("status", "=", "queued").executeTakeFirst();
  if (!job) return void res.status(409).json({ error: { code: "not_ready", message: "This job is no longer waiting at this station." } });
  try {
    await authorizeLaserStart(db, orgId, job, { fileId: job.file_id ?? "", projectHash: "sheet-check", stationToken: body.data.station_token, sheetId: body.data.sheet_id });
    const sheet = await platform().entities.lookup(orgId, "inventory:part", body.data.sheet_id);
    res.json({ id: body.data.sheet_id, name: sheet?.title ?? "Sheet confirmed" });
  } catch (e) {
    if (!(e instanceof ReviewRequired)) throw e;
    res.status(409).json({ error: { code: "material_mismatch", message: e.message } });
  }
}));

// AI-REACH: action inventory update, the station's material description is kept on the sheet record.
stationsRouter.put("/sheets/material", asyncHandler(async (req, res) => {
  // The admin tier, or an operator: saying what the sheet at the station is (#6672).
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  const parsed = Sheet.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const orgId = tenantContext(req).org.id;
  const sheet = await platform().entities.lookup(orgId, "inventory:part", parsed.data.part_id);
  if (!sheet) return void res.status(404).json({ error: { code: "not_found", message: "No such sheet." } });
  const metadata = sheet.fields.metadata as Record<string, unknown> | null;
  const native = metadata?.material != null && metadata?.width_mm != null;
  const fields = native ? parsed.data.laser_sheet : { laser_sheet: parsed.data.laser_sheet };
  const saved = await platform().entities.mergeMetadata(orgId, "inventory:part", parsed.data.part_id, fields);
  if (!saved) return void res.status(409).json({ error: { code: "not_saved", message: "This sheet's details could not be saved." } });
  const [module, entityType] = sheet.kind.split(":");
  await platform().activity.log({ orgId, userId: sessionUser(req)?.id ?? null, action: "sheet_material_updated", ref: { module: module!, entityType: entityType!, entityId: parsed.data.part_id }, before: { laser_sheet: (sheet.fields.metadata as Record<string, unknown> | null)?.laser_sheet }, diff: { laser_sheet: parsed.data.laser_sheet } });
  res.json({ ok: true });
}));

export function registerRevokeStationAction(): void {
  platform().actions.registerHandler("digifab.revoke-station", async (ctx) => {
    if (!ctx.userId || !(await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" }))) {
      return { ok: false, error: "Only workspace owners and admins can take a station's Start away." };
    }
    const said = String(((ctx.args ?? {}) as { station?: unknown }).station ?? "").trim();
    if (!said) return { ok: false, error: "Say which station, by its name." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as ReturnType<typeof tenantDb>;
    const out = await revokeStation(db, ctx.orgId, ctx.userId, said);
    return "error" in out ? { ok: false, error: out.error } : { ok: true, summary: `${out.label} can no longer start jobs.` };
  });
}
