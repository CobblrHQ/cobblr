import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { stationTokenHash } from "../laser-station.js";
import { tenantDb, tenantContext, sessionUser, type DigifabDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import type { Kysely } from "kysely";
const Target = z.object({ machine_kind: z.string().min(3).max(120), machine_id: z.string().uuid(), purpose: z.enum(["placement", "reflow", "inspection"]) });
export function registerMachineStationVerifier() {
  platform().devices.registerStationVerifier(async (orgId, request) => {
    if (!request.token || request.token.length < 32 || request.token.length > 128) throw new ActionRefusal("Authorize this screen at the machine before Start.");
    const db = await platform().tenants.getDb(orgId) as Kysely<DigifabDB>;
    const station = await db.selectFrom("digifab_stations").select(["id", "label"]).where("token_hash", "=", stationTokenHash(request.token)).where("machine_kind", "=", request.machine_kind).where("machine_id", "=", request.machine_id).where("purpose", "=", request.purpose).where("revoked_at", "is", null).executeTakeFirst();
    if (!station) throw new ActionRefusal("This station is revoked or belongs to another machine or operation. Authorize this screen at the machine.");
    const machine = await platform().devices.machineRecord(orgId, request.machine_kind, request.machine_id);
    if (!machine || machine.retired) throw new ActionRefusal("The station's machine is unavailable.");
    return station;
  });
}
export const machineStationsRouter = Router({ mergeParams: true });
// AI-REACH: exempt an owner at a physical machine grants this browser permission to start its placement, reflow or inspection work; an assistant cannot authorize a station.
machineStationsRouter.post("/", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = Target.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const p = parsed.data, orgId = tenantContext(req).org.id;
  const machine = await platform().devices.machineRecord(orgId, p.machine_kind, p.machine_id, sessionUser(req)?.id);
  if (!machine || machine.retired) return void res.status(422).json({ error: { code: "not_machine", message: "Choose an available machine." } });
  const token = randomBytes(32).toString("base64url");
  const row = await tenantDb(req).insertInto("digifab_stations").values({ connection_id: null, remote_device_id: p.machine_id, purpose: p.purpose, machine_kind: p.machine_kind, machine_id: p.machine_id, label: machine.title, token_hash: stationTokenHash(token), revoked_at: null }).returning(["id", "label"]).executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId: sessionUser(req)?.id ?? null, action: "station_created", ref: { module: "digifab", entityType: "station", entityId: row.id }, diff: { label: row.label, purpose: p.purpose } });
  res.status(201).json({ ...row, token });
}));
