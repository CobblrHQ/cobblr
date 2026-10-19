import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { DigifabDB } from "../../../db.js";
import { availableSheet, LaserPlanRefusal } from "../../../sheet-layout.js";
import { idleLaser } from "../laser-plans.js";
import { generateNestedSvg } from "../../../laser-layout.js";
import { layoutEstimate, pickLayoutAlternative, moveLayoutPart, renestLayout, validateAdjustedLayout, type LayoutAdjustment } from "../../../layout-adjustments.js";
import { exportLayout, importLayout } from "../layout-roundtrip.js";

export async function adjustLaserPlan(db:Kysely<DigifabDB>,orgId:string,userId:string|null,id:string,change:LayoutAdjustment) {
 if(change.operation==="check_move") {
  const saved=await db.selectFrom("digifab_laser_plans").selectAll().where("id","=",id).executeTakeFirst();
  if(!saved||saved.run_id||!saved.plan.adjustments)throw new LaserPlanRefusal("Choose an unqueued plan with saved adjustment settings.");
  try {moveLayoutPart(saved.plan.design,saved.plan.sheets,saved.plan.adjustments,saved.plan.quantity,{...change,operation:"move"});return {valid:true as const};}
  catch(error){if(error instanceof TypeError||error instanceof ReferenceError)throw error;throw new LaserPlanRefusal(error instanceof Error?error.message:"This move is not allowed.");}
 }
 let answer:unknown;
 const lock=await platform().exclusive.run(`laser-layout:${orgId}:${id}`,async()=>{
  const saved=await db.selectFrom("digifab_laser_plans").selectAll().where("id","=",id).executeTakeFirst();
  if(!saved)throw new LaserPlanRefusal("This plan no longer exists.");
  if(saved.run_id)throw new LaserPlanRefusal("This layout is already queued. Prepare another plan to adjust it.");
  if(await db.selectFrom("digifab_material_dispatches").select("id").where("status","in",["planned","blocked"]).where(sql<boolean>`plan_ids @> ${JSON.stringify([id])}::jsonb`).executeTakeFirst())throw new LaserPlanRefusal("Withdraw its material batch before adjusting this layout.");
  const plan=structuredClone(saved.plan),state=plan.adjustments;
  if(!state)throw new LaserPlanRefusal("Make a new plan to use layout adjustments. This older plan has no saved spacing settings.");
  const fresh=await Promise.all(state.sheets.map(s=>availableSheet(orgId,s.id)));
  if(fresh.some(s=>s.revision!==state.sheets.find(old=>old.id===s.id)!.revision))throw new LaserPlanRefusal("A chosen sheet changed. Make a new plan before adjusting it.");
  const source=await db.selectFrom("digifab_library").select("file_id").where("id","=",saved.library_id).executeTakeFirstOrThrow();
  const file=await platform().files.read(orgId,source.file_id);
  if(!file||createHash("sha256").update(file.bytes).digest("hex")!==plan.source_hash)throw new LaserPlanRefusal("The source drawing changed. Make a new plan.");
  try {
   if(change.operation==="export") {
    const sheet=plan.sheets.find(s=>s.id===change.sheet_id);if(!sheet)throw new Error("Choose a sheet in this plan.");
    const content=exportLayout(plan.design,sheet,change.format,plan.profiles);
    if(change.format==="lightburn") {
     let reviewed=false;
     const preparing=await platform().exclusive.run(`laser-start:${orgId}:${saved.connection_id}:${saved.remote_device_id}`,async()=>{
      const driver=await idleLaser(db,orgId,saved.connection_id,saved.remote_device_id);
      const review=await driver.prepareJob!(Buffer.from(content),`layout-${id}.lbrn2`);
      if(review.transport!=="rest")throw new Error("Open in LightBurn requires its REST bridge.");reviewed=true;
     });
     if(!preparing.ran||!reviewed)throw new Error("The laser is preparing another project. Wait for it to finish.");
    }
    answer={filename:`layout-${id}.${change.format==="lightburn"?"lbrn2":change.format}`,content};return;
   }
   if(change.operation==="pick") {plan.sheets=pickLayoutAlternative(state,change.alternative);}
   else if(change.operation==="lock") {if(change.parts.some(id=>!plan.sheets.some(s=>s.parts.some(p=>p.number===id&&!p.extra))))throw new Error("Choose parts in this plan.");for(const s of plan.sheets)for(const p of s.parts)if(change.parts.includes(p.number))p.locked=change.locked;}
   else if(change.operation==="clear_locks")for(const s of plan.sheets)for(const p of s.parts)p.locked=false;

   else if(change.operation==="move")plan.sheets=moveLayoutPart(plan.design,plan.sheets,state,plan.quantity,change);
   else if(change.operation==="import") {
    const result=importLayout(plan.design,plan.sheets,state,plan.quantity,change.sheet_id,change.filename,change.content,change.extras,plan.profiles,change.assignments);
    if(!result.sheets){answer={unmatched:result.unmatched,...(result.missing?{missing:result.missing}:{})};return;}plan.sheets=result.sheets;
   } else {
    if("sheet_id" in change&&!state.sheets.some(s=>s.id===change.sheet_id))throw new Error("Choose a sheet in this plan.");
    if(change.operation==="avoid") {
     const sheet=state.sheets.find(s=>s.id===change.sheet_id)!,r=change.rectangle;
     if(r.x<0||r.y<0||r.x+r.width>sheet.width||r.y+r.height>sheet.height)throw new Error("Keep the avoid box inside the sheet.");
     state.avoid[change.sheet_id]=[...(state.avoid[change.sheet_id]??[]),r];
    }
    if(change.operation==="clear_avoid")delete state.avoid[change.sheet_id];
    if(change.operation==="limit")state.limits[change.sheet_id]=change.maximum;
    if(change.operation==="fill") {delete state.limits[change.sheet_id];state.sheets.sort((a,b)=>Number(b.id===change.sheet_id)-Number(a.id===change.sheet_id));}
    plan.sheets=await renestLayout(plan.design,plan.quantity,plan.sheets,state,{budget_ms:change.operation==="renest"?change.budget_ms:3000});
    if(change.operation==="avoid"&&change.permanent) {
     const sheet=state.sheets.find(s=>s.id===change.sheet_id)!;
     const result=normaliseActionResult(await platform().actions.invoke("inventory:change-sheet-area",{
      orgId,userId,entity:{kind:"inventory:part",id:sheet.id},args:{operation:"cut",revision:sheet.revision,rectangles:[change.rectangle],source:`layout-defect:${id}:${state.revision}`,verdict:"scrap",kerf_mm:0,spacing_mm:0},
      event:{name:null,payload:{},actor:{user_id:userId,display_name:null,auth_method:"session"},timestamp:new Date().toISOString(),trigger_type:"user-invoked"},
     }),"inventory.change-sheet-area");
     if(!result.ok)throw new Error("The stock record could not save this defect area. Reload the sheet before trying again.");
     const updated=await availableSheet(orgId,sheet.id);
     state.sheets=state.sheets.map(s=>s.id===sheet.id?updated:s);
     plan.sheets=plan.sheets.map(s=>s.id===sheet.id?{...s,...updated}:s);
     state.avoid[sheet.id]=(state.avoid[sheet.id]??[]).slice(0,-1);
    }
   }
   validateAdjustedLayout(plan.design,plan.sheets,state,plan.quantity);
   plan.estimated_sec=layoutEstimate(plan.design,plan.sheets,plan.profiles);state.revision++;
   // A previous alternative cannot erase a lock, a defect or a hand adjustment.
   if(change.operation!=="pick")state.alternatives=[];
   const updated=await db.updateTable("digifab_laser_plans").set({plan}).where("id","=",id).where("run_id","is",null).where(sql<boolean>`plan = ${JSON.stringify(saved.plan)}::jsonb`).returningAll().executeTakeFirst();
   if(!updated)throw new Error("This plan changed while you were adjusting it. Reload it before trying again.");
   answer={...updated,plan:{...updated.plan,sheets:updated.plan.sheets.map(s=>({...s,svg:generateNestedSvg(updated.plan.design,s)}))}};
  }catch(error){if(error instanceof TypeError||error instanceof ReferenceError)throw error;throw new LaserPlanRefusal(error instanceof Error?error.message:"The layout could not be adjusted.");}
 });
 if(!lock.ran)throw new LaserPlanRefusal("This layout is being adjusted. Wait for the current change to finish.");
 return answer;
}
