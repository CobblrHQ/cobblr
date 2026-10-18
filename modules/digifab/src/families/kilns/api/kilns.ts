import { Router, type Response } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { sql } from "kysely";
import { z } from "zod";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { tenantDb, tenantContext, sessionUser } from "../../../db.js";
import { asyncHandler, badBody, requireRole } from "../../../api/util.js";
import { createFiring, finishFiring, KilnRefusal, readKiln, saveKilnProfile } from "../store.js";
import { controlFiring, ControlSchema } from "../control.js";
export const kilnsRouter = Router({ mergeParams: true });
const Id = z.string().uuid();
function refuse(res: Response, e: unknown) {
 if (e instanceof z.ZodError) return badBody(res, e);
 if (!(e instanceof KilnRefusal)) throw e;
 res.status(409).json({ error: { code: "kiln_refused", message: e.message } });
}
kilnsRouter.get("/:machineId", asyncHandler(async (req, res) => {
 const id = Id.parse(req.params.machineId), db = tenantDb(req), page = readListPage(req.query, 20);
 const rows = await db.selectFrom("digifab_firings").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("machine_id", "=", id).orderBy("created_at", "desc").orderBy("id", "desc").limit(page.limit).offset(page.offset).execute();
 res.json({ ...await readKiln(db, tenantContext(req).org.id, id), ...pagedAnswer(rows, page) });
}));
// AI-ACTION: digifab:kiln-log
kilnsRouter.post("/:machineId/profile", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: a kiln's profile and firing log are the admin tier's on the page, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:kiln-log"))) return;
 try { res.json(await saveKilnProfile(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.machineId), req.body)); } catch(e) { refuse(res, e); }
}));
// AI-ACTION: digifab:kiln-log
kilnsRouter.post("/:machineId/firings", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: a kiln's profile and firing log are the admin tier's on the page, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:kiln-log"))) return;
 try { res.status(201).json(await createFiring(tenantDb(req), tenantContext(req).org.id, { ...req.body, machine_id: Id.parse(req.params.machineId) }, sessionUser(req)?.id ?? null)); } catch(e) { refuse(res, e); }
}));
// AI-ACTION: digifab:kiln-log
kilnsRouter.post("/firings/:id/finish", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: a kiln's profile and firing log are the admin tier's on the page, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:kiln-log"))) return;
 try { res.json(await finishFiring(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, Id.parse(req.params.id), req.body)); } catch(e) { refuse(res, e); }
}));
// AI-REACH: exempt physical kiln Start/Stop needs the authorized screen's credential, never an assistant or a wire.
kilnsRouter.post("/firings/:id/control", asyncHandler(async (req, res) => {
 // The admin tier, or an operator: starting and stopping a firing at its screen (#6672).
 if (!(await requireCapability(req, res, "digifab:operate"))) return;
 try { res.json(await controlFiring(tenantDb(req), tenantContext(req).org.id, Id.parse(req.params.id), ControlSchema.parse(req.body))); } catch(e) { refuse(res, e); }
}));
