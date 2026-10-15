import {Router} from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import {z} from "zod";
import {sql} from "kysely";
import {pagedAnswer,readListPage,TOTAL_COLUMN} from "@cobblr/platform-contract/list-page";
import {tenantDb,tenantContext,sessionUser} from "../db.js";
import {asyncHandler,badBody} from "./util.js";
import {ReviewRequired} from "../drivers/job-review.js";
import {Printer,PrintRequest,PrintReport,createLargePrint,recordLargePrint,stopLargePrint,printStationKey} from "../large-format/service.js";
import {refreshSupplies} from "../large-format/supplies.js";
import {requireCutterStation} from "../cutter-station.js";
export const largeFormatRouter=Router({mergeParams:true});
const refuse=(res:import("express").Response,error:unknown)=>{if(!(error instanceof ReviewRequired||error instanceof z.ZodError||error instanceof Error))throw error;res.status(409).json({error:{code:"print_refused",message:error.message}});};
largeFormatRouter.get("/station",asyncHandler(async(req,res)=>{
 // ADMIN-ONLY: planning and running a large-format job is the admin tier's on the page, at every door (#5170)
 if(!(await requireCapability(req, res, "digifab:large-format")))return;
 const b=Printer.safeParse(req.query);if(!b.success)return badBody(res,b.error);
 const db=tenantDb(req),plans=await db.selectFrom("digifab_large_prints as p").innerJoin("digifab_jobs as j","j.id","p.job_id").selectAll("p").where("p.connection_id","=",b.data.connection_id).where("p.device_id","=",b.data.device_id).where("j.outcome_at","is",null).orderBy("p.created_at").limit(1).execute();
 const plan=plans[0],job=plan?await db.selectFrom("digifab_jobs").selectAll().where("id","=",plan.job_id).executeTakeFirst():null;
 const supplies=await db.selectFrom("digifab_printer_supplies").selectAll().where("connection_id","=",b.data.connection_id).where("device_id","=",b.data.device_id).execute();
 res.json({plan:plan??null,job:job??null,supplies,station:printStationKey(b.data.connection_id,b.data.device_id)});
}));
largeFormatRouter.get("/jobs",asyncHandler(async(req,res)=>{
 const b=Printer.safeParse(req.query);if(!b.success)return badBody(res,b.error);
 const page=readListPage(req.query,20),rows=await tenantDb(req).selectFrom("digifab_large_prints as p").innerJoin("digifab_jobs as j","j.id","p.job_id").select(["p.job_id","p.plan","p.report","p.created_at","p.consumed_at","j.status","j.file_ref"]).select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("p.connection_id","=",b.data.connection_id).where("p.device_id","=",b.data.device_id).orderBy("p.created_at","desc").orderBy("p.job_id").limit(page.limit).offset(page.offset).execute();res.json(pagedAnswer(rows,page));
}));
// AI-ACTION: digifab:large-format
largeFormatRouter.post("/plans",asyncHandler(async(req,res)=>{
 // ADMIN-ONLY: planning and running a large-format job is the admin tier's on the page, at every door (#5170)
 if(!(await requireCapability(req, res, "digifab:large-format")))return;
 const b=PrintRequest.safeParse(req.body);if(!b.success)return badBody(res,b.error);
 try{res.status(201).json(await createLargePrint(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}
}));
// AI-ACTION: digifab:large-format
largeFormatRouter.post("/refresh",asyncHandler(async(req,res)=>{
 // ADMIN-ONLY: planning and running a large-format job is the admin tier's on the page, at every door (#5170)
 if(!(await requireCapability(req, res, "digifab:large-format")))return;
 const b=Printer.safeParse(req.body);if(!b.success)return badBody(res,b.error);
 try{res.json(await refreshSupplies(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}
}));
// AI-ACTION: digifab:station-run
largeFormatRouter.post("/jobs/:id/outcome",asyncHandler(async(req,res)=>{
 // ADMIN-ONLY: the admin tier, or an operator: recording a print at its station (#6672)
 if(!(await requireCapability(req, res, "digifab:station-run")))return;
 const b=PrintReport.extend({station_token:z.string().min(32).max(128)}).safeParse(req.body);if(!b.success)return badBody(res,b.error);
 const db=tenantDb(req),orgId=tenantContext(req).org.id;
 try{const saved=await db.selectFrom("digifab_large_prints").selectAll().where("job_id","=",req.params.id!).executeTakeFirst();if(!saved)throw new ReviewRequired("Choose a prepared print.");await requireCutterStation(db,saved.connection_id,saved.device_id,b.data.station_token);res.json(await recordLargePrint(db,orgId,saved.job_id,sessionUser(req)?.id??"",PrintReport.parse(b.data)));}catch(error){refuse(res,error);}
}));

// AI-ACTION: digifab:stop
largeFormatRouter.post("/stop",asyncHandler(async(req,res)=>{
 if(!(await requireCapability(req, res, "digifab:stop")))return;
 const b=Printer.safeParse(req.body);if(!b.success)return badBody(res,b.error);
 try{res.json(await stopLargePrint(tenantDb(req),tenantContext(req).org.id,b.data));}catch(error){refuse(res,error);}
}));
