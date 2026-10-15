import {z} from "zod";
import type {Kysely} from "kysely";
import {platform,readJsonArg} from "@cobblr/platform-contract";
import {CutterProfileSchema} from "@cobblr/platform-contract/cutter-program";
import type {DigifabDB} from "./db.js";
import {ReviewRequired} from "./drivers/job-review.js";
import {NewCutterProfile,NewCutterPlan,CutterReportSchema,createCutterProfile,createCutterPlan,recordCutterUse} from "./cutter-plans.js";
import {CutterControlSchema,cutterControl} from "./cutter-controls.js";
import {requireCutterStation} from "./cutter-station.js";
import { mayControl, RUN_MACHINES_REFUSAL } from "./motion-gate.js";
/** A prepared cutter job's outcome, at its authorized station: the page, digifab:cutter-batch and digifab:station-run. */
export async function recordCutterOutcome(db:Kysely<DigifabDB>,orgId:string,jobId:string,userId:string,fields:unknown) {
 const saved=await db.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",jobId).executeTakeFirst();if(!saved)throw new ReviewRequired("Choose a prepared cutter job.");
 await requireCutterStation(db,saved.connection_id,saved.remote_device_id,(fields as Record<string,unknown>).station_token);
 return await recordCutterUse(db,orgId,jobId,userId,CutterReportSchema.parse(fields));
}
let registered=false;
export function registerCutterActions():void {
 if(registered)return;registered=true;
 platform().actions.registerHandler("digifab.cutter-batch",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"admin"}))return {ok:false,error:"Preparing cutter jobs requires an admin."};
  try {
   const args=ctx.args??{},fields=readJsonArg(args,"fields")??{},db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
   if(args.operation==="create_profile")return {ok:true,...await createCutterProfile(db,ctx.orgId,NewCutterProfile.parse(fields))};
   if(args.operation==="plan")return {ok:true,...await createCutterPlan(db,ctx.orgId,NewCutterPlan.parse(fields))};
   const id=z.string().uuid().parse(args.id);
   if(args.operation==="update_profile") {const row=await db.updateTable("digifab_cutter_profiles").set({profile:CutterProfileSchema.parse(fields),updated_at:new Date()}).where("id","=",id).returningAll().executeTakeFirst();return row?{ok:true,...row}:{ok:false,error:"No such cutter profile."};}
   if(args.operation==="outcome")return await recordCutterOutcome(db,ctx.orgId,id,ctx.userId,fields);
   return {ok:false,error:"Choose create_profile, update_profile, plan or outcome."};
  }catch(error){if(error instanceof ReviewRequired||error instanceof z.ZodError)return {ok:false,error:error.message};throw error;}
 });
 platform().actions.registerHandler("digifab.cutter-control",async ctx=>{
  if(!ctx.userId||!await platform().auth.userHasRole({orgId:ctx.orgId,userId:ctx.userId,minRole:"member"}))return {ok:false,error:"Sign in to this workspace to use cutter controls."};
  try {const control=CutterControlSchema.parse(ctx.args);if(!await mayControl({orgId:ctx.orgId,userId:ctx.userId,operation:control.operation}))return {ok:false,error:RUN_MACHINES_REFUSAL};const db=await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;return await cutterControl(db,ctx.orgId,control);}
  catch(error){if(error instanceof ReviewRequired||error instanceof z.ZodError)return {ok:false,error:error.message};throw error;}
 });
}
