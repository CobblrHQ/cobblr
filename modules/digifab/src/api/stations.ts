import { sql } from "kysely";
import { libraryForJob } from "../laser-plans.js";
import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { authorizeLaserStart, stationTokenHash } from "../laser-station.js";
import { ReviewRequired } from "../drivers/job-review.js";
import { LaserMaterialSchema, materialFromFields } from "../laser-material.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

import { machineStationsRouter } from "./machine-stations.js";

export const stationsRouter = Router({ mergeParams: true });
stationsRouter.use("/machines", machineStationsRouter);
const Machine = z.object({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200) });

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
  if (!device || !await driver?.jobReviewRequired?.()) return void res.status(409).json({ error: { code: "not_laser", message: "Choose a connected laser with job review." } });
  const token = randomBytes(32).toString("base64url");
  const row = await db.insertInto("digifab_stations").values({ connection_id: parsed.data.connection_id, remote_device_id: device.id, label: device.name, token_hash: stationTokenHash(token), revoked_at: null }).returning(["id", "label"]).executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId: sessionUser(req)?.id ?? null, action: "station_created", ref: { module: "digifab", entityType: "station", entityId: row.id }, diff: { label: row.label } });
  res.status(201).json({ ...row, token });
}));

stationsRouter.get("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  res.json({ items: await tenantDb(req).selectFrom("digifab_stations").select(["id", "label", "connection_id", "remote_device_id", "purpose", "machine_kind", "machine_id", "created_at", "revoked_at"]).orderBy("created_at", "desc").execute() });
}));

// AI-REACH: exempt an owner revokes a station screen's Start permission.
stationsRouter.delete("/:id", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  await tenantDb(req).updateTable("digifab_stations").set({ revoked_at: new Date() }).where("id", "=", req.params.id!).execute();
  await platform().activity.log({ orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null, action: "station_revoked", ref: { module: "digifab", entityType: "station", entityId: req.params.id! } });
  res.json({ ok: true });
}));

stationsRouter.get("/:connectionId/:deviceId", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const orgId = tenantContext(req).org.id;
  const db = tenantDb(req);
  const connection = req.params.connectionId!;
  const device = req.params.deviceId!;
  const jobs = await db.selectFrom("digifab_jobs").selectAll().where("connection_id", "=", connection).where("target_device", "=", device).where("status", "in", ["queued", "sent", "printing", "paused"]).orderBy("priority", "desc").orderBy("created_at", "asc").orderBy(sql<number>`coalesce((laser_layout ->> 'sheet_index')::int, 0)`, "asc").orderBy("id", "asc").execute();
  const attention = await db.selectFrom("digifab_device_attention").selectAll().where("connection_id", "=", connection).where("remote_device_id", "=", device).executeTakeFirst();
  const job = jobs.find(j => j.status !== "queued") ?? jobs[0] ?? null;
  const library = job ? await libraryForJob(db, job) : null;
  const stockKind = "inventory:part";
  const stockModule = stockKind.split(":")[0];
  const inventories = (await platform().instances.list(orgId)).filter(i => i.module_name === stockModule);
  const kinds = [...new Set(["inventory:part", ...inventories.map(i => i.is_default ? "inventory:part" : `${i.instance_name}:item`)])];
  const lists = await Promise.all(kinds.map(kind => platform().entities.list(orgId, kind, { q: typeof req.query.q === "string" ? req.query.q : undefined, limit: 100 })));
  const sheets = { items: lists.flatMap(l => l.items) };
  res.json({ job, library: library ?? null, attention: attention ?? null, sheets: sheets.items.filter(s => !s.retired && Number(s.fields.qty ?? 0) > 0).map(s => ({ id: s.id, name: s.title, material: materialFromFields(s.fields) })) });
}));

const Sheet = z.object({ part_id: z.string().uuid(), laser_sheet: LaserMaterialSchema });
const Confirm = z.object({ job_id: z.string().uuid(), sheet_id: z.string().uuid(), station_token: z.string().min(32).max(128) });
// AI-REACH: exempt confirms the sheet physically loaded at a laser station, with that screen's credential.
stationsRouter.post("/:connectionId/:deviceId/confirm", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
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
  if (!requireRole(req, res, "owner", "admin")) return;
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
