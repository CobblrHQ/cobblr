import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { benchMachine, benchNames, runBench } from "../bench.js";
import { discoverBenchESPHome } from "../bench-discovery.js";
import { BenchRequest } from "../bench-model.js";
import { readBenchPage } from "../bench-page.js";
export const benchRouter=Router({mergeParams:true});
// AI-ACTION: digifab:discover-esphome
benchRouter.get("/discover",asyncHandler(async(req,res)=>{
 if(!requireRole(req,res,"owner","admin"))return;
 const bridge=z.string().min(1).max(60).nullable().safeParse(req.query.bridge || null);if(!bridge.success)return badBody(res,bridge.error);
 res.json(await discoverBenchESPHome(tenantContext(req).org.id,bridge.data));
}));
benchRouter.get("/:machineId",asyncHandler(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.machineId);if(!id.success)return badBody(res,id.error);
 const db=tenantDb(req);
 const page=readListPage(req.query,20);
 const {saved:rows,instrument:machine,connection_error}=await readBenchPage({
  live:()=>benchMachine(db,tenantContext(req).org.id,id.data),
  saved:()=>db.selectFrom("digifab_bench_readings").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("machine_id","=",id.data).orderBy("created_at","desc").orderBy("id","desc").limit(page.limit).offset(page.offset).execute(),
 });
 const names=await benchNames(db,tenantContext(req).org.id,id.data);
 res.json({...pagedAnswer(rows,page),...names,connection_error,instrument:machine?{connection_id:machine.link.connection_id,device_id:machine.link.remote_device_id,name:machine.device.name,...machine.device.raw!.bench as Record<string,unknown>}:null});
}));
// AI-ACTION: digifab:instrument, digifab:instrument-control, digifab:instrument-stop
benchRouter.post("/",asyncHandler(async(req,res)=>{
 if(!(await requireCapability(req, res, "digifab:instrument")))return;
 const parsed=BenchRequest.safeParse(req.body);if(!parsed.success)return badBody(res,parsed.error);
 try{res.json(await runBench(tenantDb(req),tenantContext(req).org.id,parsed.data,sessionUser(req)?.id || null));}catch(error){res.status(409).json({error:{code:"bench_refused",message:error instanceof Error?error.message:"The instrument did not answer."}});}
}));
