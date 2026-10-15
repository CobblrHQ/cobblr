import { requireCapability } from "@cobblr/platform-contract/action-gate";
import {Router} from "express";
import {z} from "zod";
import {sql} from "kysely";
import {pagedAnswer,readListPage,TOTAL_COLUMN} from "@cobblr/platform-contract/list-page";
import {CutterProfileSchema} from "@cobblr/platform-contract/cutter-program";
import {tenantDb,tenantContext,sessionUser} from "../db.js";
import {asyncHandler,badBody,requireRole} from "./util.js";
import {ReviewRequired} from "../drivers/job-review.js";
import {CutterMachine,NewCutterProfile,NewCutterPlan,CutterReportSchema,createCutterProfile,createCutterPlan,recordCutterUse} from "../cutter-plans.js";
import {cutterStock,cutterStationKey} from "../cutter-stock.js";
import {CutterControlSchema,cutterControl} from "../cutter-controls.js";
import {isStopControl,RUN_MACHINES} from "../motion-gate.js";
import {requireCutterStation} from "../cutter-station.js";
export const cutterRouter=Router({mergeParams:true});
const refuse=(res:import("express").Response,error:unknown)=>{if(!(error instanceof ReviewRequired||error instanceof z.ZodError))throw error;res.status(409).json({error:{code:"cutter_refused",message:error.message}});};
cutterRouter.get("/profiles",asyncHandler(async(req,res)=>{
 const b=CutterMachine.safeParse(req.query);if(!b.success)return badBody(res,b.error);
 const page=readListPage(req.query,20),rows=await tenantDb(req).selectFrom("digifab_cutter_profiles").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("connection_id","=",b.data.connection_id).where("remote_device_id","=",b.data.device_id).orderBy("created_at").orderBy("id").limit(page.limit).offset(page.offset).execute();res.json(pagedAnswer(rows,page));
}));
// AI-ACTION: digifab:cutter-batch
// ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
cutterRouter.post("/profiles",asyncHandler(async(req,res)=>{if(!(await requireCapability(req, res, "digifab:cutter-batch")))return;const b=NewCutterProfile.safeParse(req.body);if(!b.success)return badBody(res,b.error);try{res.status(201).json(await createCutterProfile(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}}));
// AI-ACTION: digifab:cutter-batch
// ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
cutterRouter.put("/profiles/:id",asyncHandler(async(req,res)=>{if(!(await requireCapability(req, res, "digifab:cutter-batch")))return;const b=CutterProfileSchema.safeParse(req.body);if(!b.success)return badBody(res,b.error);const row=await tenantDb(req).updateTable("digifab_cutter_profiles").set({profile:b.data,updated_at:new Date()}).where("id","=",req.params.id!).returningAll().executeTakeFirst();if(!row)return void res.status(404).json({error:{code:"not_found",message:"No such cutter profile."}});res.json(row);}));
// AI-ACTION: digifab:cutter-batch
// ADMIN-ONLY: starting, stopping and setting up a machine stays with the admin tier, at every door (#5170)
cutterRouter.post("/plans",asyncHandler(async(req,res)=>{if(!(await requireCapability(req, res, "digifab:cutter-batch")))return;const b=NewCutterPlan.safeParse(req.body);if(!b.success)return badBody(res,b.error);try{res.status(201).json(await createCutterPlan(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}}));
cutterRouter.get("/station",asyncHandler(async(req,res)=>{
 if(!requireRole(req,res,"owner","admin"))return;
 const b=CutterMachine.safeParse(req.query);if(!b.success)return badBody(res,b.error);
 const db=tenantDb(req),orgId=tenantContext(req).org.id;
 const attention=await db.selectFrom("digifab_device_attention").selectAll().where("connection_id","=",b.data.connection_id).where("remote_device_id","=",b.data.device_id).executeTakeFirst();
 const plans=await db.selectFrom("digifab_cutter_plans").selectAll().where("connection_id","=",b.data.connection_id).where("remote_device_id","=",b.data.device_id).where("consumed_at","is",null).orderBy("created_at").limit(1).execute();
 const plan=attention?.job_id?await db.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",attention.job_id).executeTakeFirst():plans[0];
 const job=plan?await db.selectFrom("digifab_jobs").selectAll().where("id","=",plan.job_id).executeTakeFirst():null;
 try{res.json({plan:plan??null,job:job??null,attention:attention??null,stock:await cutterStock(orgId,b.data.connection_id,b.data.device_id),station_key:cutterStationKey(b.data.connection_id,b.data.device_id)});}catch(error){refuse(res,error);}
}));
// AI-ACTION: digifab:station-run
cutterRouter.post("/jobs/:id/outcome",asyncHandler(async(req,res)=>{
 // ADMIN-ONLY: the admin tier, or an operator: recording a cut at its station (#6672)
 if(!(await requireCapability(req, res, "digifab:station-run")))return;
 const body=CutterReportSchema.extend({station_token:z.string().min(32).max(128)}).safeParse(req.body);if(!body.success)return badBody(res,body.error);
 const db=tenantDb(req),orgId=tenantContext(req).org.id;
 try{const saved=await db.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",req.params.id!).executeTakeFirst();if(!saved)throw new ReviewRequired("Choose a prepared cutter job.");await requireCutterStation(db,saved.connection_id,saved.remote_device_id,body.data.station_token);res.json(await recordCutterUse(db,orgId,saved.job_id,sessionUser(req)?.id ?? "",CutterReportSchema.parse(body.data)));}catch(error){refuse(res,error);}
}));
// AI-ACTION: digifab:cutter-control
cutterRouter.post("/control",asyncHandler(async(req,res)=>{if(!(await requireCapability(req, res, "digifab:cutter-control")))return;const b=CutterControlSchema.safeParse(req.body);if(!b.success)return badBody(res,b.error);if(!isStopControl(b.data.operation)&&!(await requireCapability(req, res, RUN_MACHINES)))return;try{res.json(await cutterControl(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}}));
