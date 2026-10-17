import { Router, type Response } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { sql } from "kysely";
import { z } from "zod";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { ArmCommandSchema } from "@cobblr/platform-contract/robot-arm";
import { tenantDb, tenantContext, sessionUser } from "../../../db.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { asyncHandler, badBody, requireRole } from "../../../api/util.js";
import { ArmRefusal } from "../station.js";
import { addTypedProgram, editProgram, readArm, readFamily, refreshArm, saveCompatibility, setMaintenance, setupArm } from "../store.js";
import { sendArmCommand } from "../control.js";
export const armsRouter = Router({ mergeParams: true });
const Id = z.string().uuid();
function refuse(res: Response, e: unknown) {
 if (e instanceof z.ZodError) return badBody(res, e);
 if (!(e instanceof ArmRefusal)) throw e;
 res.status(409).json({ error: { code: "arm_refused", message: e.message } });
}
armsRouter.get("/families/:family", asyncHandler(async (req, res) => {
 res.json({ family: req.params.family, items: await readFamily(tenantDb(req), z.string().min(1).max(200).parse(req.params.family)) });
}));
armsRouter.get("/:machineId", asyncHandler(async (req, res) => {
 const id = Id.parse(req.params.machineId), db = tenantDb(req), page = readListPage(req.query, 20);
 const rows = await db.selectFrom("digifab_arm_commands").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("machine_id", "=", id).orderBy("created_at", "desc").orderBy("id", "desc").limit(page.limit).offset(page.offset).execute();
 res.json({ ...await readArm(db, tenantContext(req).org.id, id), ...pagedAnswer(rows, page) });
}));
// AI-ACTION: digifab:arm-record
armsRouter.post("/:machineId/setup", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.json(await setupArm(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-record
armsRouter.post("/:machineId/refresh", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.json(await refreshArm(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId))); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-record
armsRouter.post("/:machineId/programs", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.status(201).json(await addTypedProgram(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-record
armsRouter.patch("/programs/:id", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.json(await editProgram(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.id), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-record
armsRouter.patch("/:machineId/compatibility", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.json(await saveCompatibility(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-record
armsRouter.patch("/:machineId/maintenance", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: an arm's controller, programs, compatibility and service state are the admin tier's on the page, at every door
 if (!(await requireCapability(req, res, "digifab:arm-record"))) return;
 try { res.json(await setMaintenance(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.machineId), req.body)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:arm-stop
// Cobb pauses and stops through digifab:arm-stop; load, start, resume and power need the authorized station's credential, never an assistant or a wire.
armsRouter.post("/:machineId/command", asyncHandler(async (req, res) => {
 const command = ArmCommandSchema.safeParse(req.body?.command);
 if (!command.success) return badBody(res, command.error);
 const op = command.data.operation;
 // Pause and stop are every member's; running an arm is an operator's or the admin tier's (#6672); power is the admin tier's.
 if (op === "pause" || op === "stop") { if (!(await requireCapability(req, res, "digifab:arm-stop"))) return; }
 else if (op === "power") { if (!requireRole(req, res, "admin")) return; }
 else if (!(await requireCapability(req, res, "digifab:operate"))) return;
 const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
 try {
  res.json(await sendArmCommand(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), req.body, {
   userId: sessionUser(req)?.id ?? null, via: typeof req.body?.station_token === "string" ? "station" : "page",
   operate: op !== "pause" && op !== "stop", admin: roleSatisfies(role, ["admin"]),
  }));
 } catch (e) { refuse(res, e); }
}));
