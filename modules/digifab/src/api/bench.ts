import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { tenantContext, tenantDb, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { benchMachine, runBench } from "../bench.js";
import { BenchRequest } from "../bench-model.js";
export const benchRouter=Router({mergeParams:true});
benchRouter.get("/:machineId",asyncHandler(async(req,res)=>{
 const id=z.string().uuid().safeParse(req.params.machineId);if(!id.success)return badBody(res,id.error);
 const db=tenantDb(req);
 let machine:Awaited<ReturnType<typeof benchMachine>>=null,connection_error:string|null=null;
 try{machine=await benchMachine(db,tenantContext(req).org.id,id.data);}catch(error){connection_error=error instanceof Error?error.message:"The bridge is unavailable.";}
 const page=readListPage(req.query,20);
 const rows=await db.selectFrom("digifab_bench_readings").selectAll().select(sql<string>`count(*) over()`.as(TOTAL_COLUMN)).where("machine_id","=",id.data).orderBy("created_at","desc").orderBy("id","desc").limit(page.limit).offset(page.offset).execute();
 res.json({...pagedAnswer(rows,page),connection_error,instrument:machine?{connection_id:machine.link.connection_id,device_id:machine.link.remote_device_id,name:machine.device.name,...machine.device.raw!.bench as Record<string,unknown>}:null});
}));
// AI-ACTION: digifab:instrument
benchRouter.post("/",asyncHandler(async(req,res)=>{
 if(!requireRole(req,res,"member"))return;
 const parsed=BenchRequest.safeParse(req.body);if(!parsed.success)return badBody(res,parsed.error);
 try{res.json(await runBench(tenantDb(req),tenantContext(req).org.id,parsed.data,sessionUser(req)?.id || null));}catch(error){res.status(409).json({error:{code:"bench_refused",message:error instanceof Error?error.message:"The instrument did not answer."}});}
}));
