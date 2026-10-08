import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { LaserSetupRequestSchema } from "@cobblr/platform-contract/laser-setup";
import { runLaserSetup } from "../laser-setup.js";
import { ReviewRequired } from "../drivers/job-review.js";
import { DriverSaid } from "../job-truth.js";
import { sql } from "kysely";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { Router, type Response } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { parseDesign } from "../laser-design.js";
import { ProfileSchema } from "../laser-layout.js";
import { acceptLaserPlan, LaserPlanRefusal } from "../laser-plans.js";
import { Machine, Plan, NewProfile, createLaserProfile, NestDrawing, nestDrawing, createLaserPlan, discardLaserPlan, importLaserProfiles, updateLaserProfile } from "./laser-writes.js";
export const laserRouter = Router({ mergeParams: true });
const refuse = (res: Response, e: unknown) => { if (!(e instanceof LaserPlanRefusal)) throw e; res.status(409).json({ error: { code: "laser_plan_refused", message: e.message } }); };
const setupRefusal=(res:Response,error:unknown)=>{
 if(error instanceof ReviewRequired)return res.status(409).json({error:{code:"laser_setup_refused",message:error.message}});
 if(error instanceof DriverSaid)return res.status(502).json({error:{code:"laser_connection_failed",message:error.message}});
 throw error;
};
laserRouter.get("/profiles", asyncHandler(async (req, res) => {
 const p = Machine.safeParse(req.query); if (!p.success) return badBody(res, p.error);
 res.json({ items: await tenantDb(req).selectFrom("digifab_laser_profiles").selectAll().where("connection_id", "=", p.data.connection_id).where("remote_device_id", "=", p.data.device_id).orderBy("created_at", "asc").execute() });
}));
// AI-ACTION: digifab:laser-batch
laserRouter.post("/profiles", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 const p = NewProfile.safeParse(req.body); if (!p.success) return badBody(res, p.error);
 try { res.status(201).json(await createLaserProfile(tenantDb(req), tenantContext(req).org.id, p.data)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:laser-batch
laserRouter.post("/profiles/import", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 const p = Machine.safeParse(req.body); if (!p.success) return badBody(res, p.error);
 try { res.json(await importLaserProfiles(tenantDb(req), tenantContext(req).org.id, p.data)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:laser-batch
laserRouter.put("/profiles/:id", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 const p = ProfileSchema.safeParse(req.body); if (!p.success) return badBody(res, p.error);
 const db = tenantDb(req);
 if (!await db.selectFrom("digifab_laser_profiles").select("id").where("id", "=", req.params.id!).executeTakeFirst()) return void res.status(404).json({ error: { code: "not_found", message: "No such material profile." } });
 try { res.json(await updateLaserProfile(db, req.params.id!, p.data)); } catch (e) { refuse(res, e); }
}));
laserRouter.get("/plans", asyncHandler(async (req, res) => {
 const p = z.object({ library_id: z.string().uuid() }).safeParse(req.query); if (!p.success) return badBody(res, p.error);
 const page = readListPage(req.query, 20);
 const rows = await tenantDb(req).selectFrom("digifab_laser_plans").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("library_id", "=", p.data.library_id).where("run_id", "is", null).orderBy("created_at", "desc").limit(page.limit).offset(page.offset).execute();
 res.json(pagedAnswer(rows, page));
}));
// AI-ACTION: digifab:laser-batch
laserRouter.post("/plans", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 const p = Plan.safeParse(req.body); if (!p.success) return badBody(res, p.error);
 try { res.status(201).json(await createLaserPlan(tenantDb(req), tenantContext(req).org.id, p.data)); } catch (e) { refuse(res, e); }
}));
laserRouter.get("/design/:id", asyncHandler(async (req, res) => {
 const item = await tenantDb(req).selectFrom("digifab_library").select("file_id").where("id", "=", req.params.id!).executeTakeFirst();
 const file = item && await platform().files.read(tenantContext(req).org.id, item.file_id);
 if (!file) return void res.status(404).json({ error: { code: "not_found", message: "No such drawing." } });
 try { res.json(parseDesign(file.filename, file.bytes, req.query.units === "in" ? "in" : "mm")); } catch (e) { res.status(422).json({ error: { code: "unsupported_design", message: e instanceof Error ? e.message : "The drawing could not be read." } }); }
}));
// AI-ACTION: digifab:laser-batch
laserRouter.post("/plans/:id/accept", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 try { res.json(await acceptLaserPlan(tenantDb(req), tenantContext(req).org.id, req.params.id!)); } catch (e) { refuse(res, e); }
}));
// AI-ACTION: digifab:laser-batch
laserRouter.delete("/plans/:id", asyncHandler(async (req, res) => {
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 try { res.json(await discardLaserPlan(tenantDb(req), req.params.id!)); } catch (e) { refuse(res, e); }
}));

laserRouter.get("/setup", asyncHandler(async (req,res)=>{
 if(!requireRole(req,res,"owner","admin"))return;
 const parsed=LaserSetupRequestSchema.safeParse({...req.query,operation:"read"});if(!parsed.success)return badBody(res,parsed.error);
 try{res.json(await runLaserSetup(tenantDb(req),tenantContext(req).org.id,parsed.data));}catch(error){setupRefusal(res,error);}
}));
// AI-ACTION: digifab:laser-setup
// UI-SCREEN: /station/machine/:connectionId/:deviceId
laserRouter.post("/setup", asyncHandler(async (req,res)=>{
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if(!(await requireCapability(req, res, "digifab:laser-setup")))return;
 const parsed=LaserSetupRequestSchema.safeParse(req.body);if(!parsed.success)return badBody(res,parsed.error);
 try{res.json(await runLaserSetup(tenantDb(req),tenantContext(req).org.id,parsed.data));}catch(error){setupRefusal(res,error);}
}));
// AI-ACTION: digifab:laser-batch
laserRouter.post("/nest", asyncHandler(async (req,res)=>{
 // ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
 if (!(await requireCapability(req, res, "digifab:laser-batch"))) return;
 const p=NestDrawing.safeParse(req.body);if(!p.success)return badBody(res,p.error);
 try { res.json(await nestDrawing(tenantDb(req),tenantContext(req).org.id,p.data)); } catch(e) { refuse(res,e); }
}));
