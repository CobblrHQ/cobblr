// A machine's alarms and how it has been used, for any machine Digital
// Fabrication follows (core/alarms.ts, core/utilisation.ts).
import { Router, type Response } from "express";
import { z } from "zod";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { readListPage } from "@cobblr/platform-contract/list-page";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { acknowledgeAlarm, AlarmRefusal, escalationOf, readAlarms, setEscalation } from "../core/alarms.js";
import { readUtilisation } from "../core/utilisation.js";

export const careRouter = Router({ mergeParams: true });
const Id = z.string().uuid();
function refuse(res: Response, e: unknown) {
  if (e instanceof z.ZodError) return badBody(res, e);
  if (!(e instanceof AlarmRefusal)) throw e;
  res.status(409).json({ error: { code: "alarm_refused", message: e.message } });
}

careRouter.get("/alarm-escalation", asyncHandler(async (req, res) => {
  const p = await escalationOf(tenantDb(req));
  res.json({ operators: p.operators, supervisors: p.supervisors, integrators: p.integrators, supervisor_after_minutes: p.supervisor_after_minutes, integrator_after_minutes: p.integrator_after_minutes });
}));
// AI-ACTION: digifab:alarm-escalation
careRouter.post("/alarm-escalation", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: who is called about every machine's alarms is the admin tier's, at every door
  if (!(await requireCapability(req, res, "digifab:alarm-escalation"))) return;
  try { res.json(await setEscalation(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:alarm-ack
careRouter.post("/alarms/:id/ack", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:alarm-ack"))) return;
  try { res.json(await acknowledgeAlarm(tenantDb(req), tenantContext(req).org.id, sessionUser(req)!.id, { ...req.body, alarm_id: req.params.id })); } catch (e) { refuse(res, e); }
}));
careRouter.get("/:machineId", asyncHandler(async (req, res) => {
  const id = Id.parse(req.params.machineId), db = tenantDb(req);
  const hours = z.coerce.number().int().min(1).max(24 * 90).default(24).parse(req.query.hours ?? undefined);
  res.json({ machine_id: id, utilisation: await readUtilisation(db, id, hours), ...await readAlarms(db, id, readListPage(req.query, 20)) });
}));
