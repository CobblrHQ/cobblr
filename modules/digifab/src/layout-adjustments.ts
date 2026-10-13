import polygonClipping from "polygon-clipping";
import { z } from "zod";
import { designOutline, nestOutlines, sheetObstacles, type NestOptions } from "./outline-nesting.js";
import { canRecordCuts, generateProject, transformPlacedPoint, type Design, type LayoutSheet, type Placement, type Point, type Profile, type Rect, type Sheet } from "./laser-layout.js";

export type LayoutGoal = "most_parts" | "fewest_sheets" | "shortest_time";
export type LayoutAlternative = { goal: LayoutGoal; seed: number; sheets: LayoutSheet[]; utilisation: number; estimated_sec: number };
export type LayoutAdjustments = { sheets: Sheet[]; spacing_mm: number; kerf_mm: number; rotate: boolean; rotation_step: number; allow_flip: boolean; seed: number; avoid: Record<string, Rect[]>; limits: Record<string, number>; alternatives: LayoutAlternative[]; selected: number; revision: number };
const rectangle = z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().positive().finite(),height:z.number().positive().finite()});
export const AdjustLayout = z.discriminatedUnion("operation", [
 z.object({operation:z.literal("pick"),alternative:z.number().int().min(0).max(2)}),
 z.object({operation:z.literal("lock"),parts:z.array(z.number().int().positive()).min(1).max(10000),locked:z.boolean()}),
 z.object({operation:z.literal("clear_locks")}),
 z.object({operation:z.literal("avoid"),sheet_id:z.string(),rectangle,permanent:z.boolean().default(false)}),
 z.object({operation:z.literal("clear_avoid"),sheet_id:z.string()}),
 z.object({operation:z.literal("renest"),budget_ms:z.number().int().min(100).max(30000).default(3000)}),
 z.object({operation:z.literal("move"),part:z.number().int().positive(),sheet_id:z.string(),x:z.number().finite(),y:z.number().finite(),angle:z.number().finite().optional(),mirrored:z.boolean().optional()}),
 z.object({operation:z.literal("check_move"),part:z.number().int().positive(),sheet_id:z.string(),x:z.number().finite(),y:z.number().finite(),angle:z.number().finite().optional(),mirrored:z.boolean().optional()}),
 z.object({operation:z.literal("limit"),sheet_id:z.string(),maximum:z.number().int().min(0).max(10000)}),
 z.object({operation:z.literal("fill"),sheet_id:z.string()}),
 z.object({operation:z.literal("export"),sheet_id:z.string(),format:z.enum(["svg","dxf","lightburn"])}),
 z.object({operation:z.literal("import"),sheet_id:z.string(),filename:z.string().max(200),content:z.string().max(2*1024*1024),extras:z.enum(["review","keep","drop"]).default("review"),assignments:z.record(z.string(),z.number().int().positive()).default({})}),
]);
export type LayoutAdjustment = z.infer<typeof AdjustLayout>;
export const boxOutline = (r:Rect):Point[] => [{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];
export function outlineBounds(points:Point[]):Rect {
 const x=Math.min(...points.map(p=>p.x)),y=Math.min(...points.map(p=>p.y));
 return {x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y};
}
function contourOf(design:Design):Point[] {
 try{return designOutline(design)?.points??boxOutline({x:0,y:0,width:design.width,height:design.height});}
 catch(error){if(error instanceof TypeError||error instanceof RangeError||error instanceof ReferenceError)throw error;return boxOutline({x:0,y:0,width:design.width,height:design.height});}
}
export function recordedOutline(part:Placement):Point[] {return part.footprint_outline&&part.footprint_outline.length<=256?part.footprint_outline:boxOutline(part.footprint);}
export function partOutline(design:Design,part:Placement):Point[] {
 const d=part.design ?? design;
 const outline=contourOf(d);
 return outline.map(p=>transformPlacedPoint(p,part,d.height));
}
const ring = (p:Point[]):polygonClipping.Ring => [...p,p[0]!].map(v=>[v.x,v.y]);
function pointSegment(p:Point,a:Point,b:Point):number {
 const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;
 const t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;
 return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
function tooClose(a:Point[],b:Point[],gap:number,x=outlineBounds(a),y=outlineBounds(b)):boolean {
 if(x.x+x.width+gap<y.x||y.x+y.width+gap<x.x||x.y+x.height+gap<y.y||y.y+y.height+gap<x.y)return false;
 if(polygonClipping.intersection([ring(a)],[ring(b)]).length)return true;
 for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++) {
  const p=a[i]!,q=a[(i+1)%a.length]!,r=b[j]!,s=b[(j+1)%b.length]!;
  if(Math.min(pointSegment(p,r,s),pointSegment(q,r,s),pointSegment(r,p,q),pointSegment(s,p,q))<gap-1e-5)return true;
 }
 return false;
}
export function validateAdjustedLayout(design:Design,sheets:LayoutSheet[],state:LayoutAdjustments,quantity:number):void {
 const all=sheets.flatMap(s=>s.parts).filter(p=>!p.extra);
 if(all.length!==quantity||new Set(all.map(p=>p.number)).size!==quantity)throw new Error("The layout must keep every requested part exactly once.");
 const gap=state.spacing_mm+state.kerf_mm;
 for(const sheet of sheets) {
  if(sheet.parts.some(p=>p.extra)&&!sheet.parts.some(p=>!p.extra))throw new Error("Keep a requested job part on a sheet that also cuts extras.");
  const original=state.sheets.find(s=>s.id===sheet.id);
  if(!original)throw new Error("Choose a sheet already in this plan.");
  if(sheet.parts.filter(p=>!p.extra).length>(state.limits[sheet.id]??quantity))throw new Error("This sheet exceeds its saved part limit.");
  const obstacles=[...sheetObstacles(original),...(state.avoid[sheet.id]??[]).map(boxOutline)];
  const outlines=sheet.parts.map(p=>partOutline(design,p)),bounds=outlines.map(outlineBounds),obstacleBounds=obstacles.map(outlineBounds);
  if(!canRecordCuts(original.cut_capacity,[],sheet.parts.map(recordedOutline)))throw new Error("This sheet cannot record all these cuts. Use another sheet.");
  for(let i=0;i<outlines.length;i++) {
   const p=outlines[i]!;
   if(p.some(v=>!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<gap/2-1e-5||v.y<gap/2-1e-5||v.x>sheet.width-gap/2+1e-5||v.y>sheet.height-gap/2+1e-5))throw new Error("This part reaches the sheet edge. Leave room for spacing and kerf.");
   if(original.outline&&polygonClipping.difference([ring(p)],[ring(original.outline)]).length)throw new Error("This part reaches outside the sheet outline.");
   if(obstacles.some((o,j)=>tooClose(p,o,gap,bounds[i]!,obstacleBounds[j]!)))throw new Error("This part reaches a used or avoided area. Leave room for spacing and kerf.");
   for(let j=0;j<i;j++)if(tooClose(p,outlines[j]!,gap,bounds[i]!,bounds[j]!))throw new Error("This part breaks spacing or kerf beside another part.");
  }
 }
}
export function moveLayoutPart(design:Design,sheets:LayoutSheet[],state:LayoutAdjustments,quantity:number,move:Extract<LayoutAdjustment,{operation:"move"}>):LayoutSheet[] {
 const next=structuredClone(sheets),source=next.find(s=>s.parts.some(p=>p.number===move.part&&!p.extra));
 const part=source?.parts.find(p=>p.number===move.part&&!p.extra);
 const destination=next.find(s=>s.id===move.sheet_id) ?? state.sheets.find(s=>s.id===move.sheet_id);
 if(!part||!source||!destination)throw new Error("Choose a part and sheet from this plan.");
 const angle=move.angle ?? part.angle ?? (part.rotated?90:0),mirrored=move.mirrored ?? part.mirrored ?? false;
 if(!Number.isFinite(angle)||Math.abs(angle/state.rotation_step-Math.round(angle/state.rotation_step))>1e-6||!state.rotate&&angle%360!==0)throw new Error("Rotate in this plan's allowed steps.");
 if(mirrored&&!state.allow_flip)throw new Error("Flipping is not allowed in this plan.");
 const d=part.design ?? design,rad=angle*Math.PI/180;
 const raw=contourOf(d).map(p=>({x:(mirrored?-p.x:p.x)*Math.cos(rad)-p.y*Math.sin(rad),y:(mirrored?-p.x:p.x)*Math.sin(rad)+p.y*Math.cos(rad)}));
 const b=outlineBounds(raw);
 Object.assign(part,{x:move.x,y:move.y,width:b.width,height:b.height,angle,translation:{x:move.x-b.x,y:move.y-b.y},mirrored,rotated:angle%180!==0,locked:true});
 const points=partOutline(design,part),margin=(state.spacing_mm+state.kerf_mm)/2;
 part.footprint={x:move.x-margin,y:move.y-margin,width:b.width+2*margin,height:b.height+2*margin};part.footprint_outline=points;
 if(source.id!==destination.id) {source.parts=source.parts.filter(p=>p!==part);let target=next.find(s=>s.id===destination.id);if(!target){target={...destination,parts:[],remaining:[]};next.push(target);}target.parts.push(part);}
 validateAdjustedLayout(design,next,state,quantity);
 return next.filter(s=>s.parts.length);
}
export function layoutEstimate(design:Design,sheets:LayoutSheet[],profiles:Record<string,Profile>):number {
 let seconds=0;
 for(const sheet of sheets) {
  if(Object.keys(profiles).length)seconds+=generateProject(design,sheet,profiles).estimated_sec;
  let previous={x:0,y:0};
  for(const part of sheet.parts) {seconds+=Math.hypot(part.x-previous.x,part.y-previous.y)/100;previous=part;}
 }
 return Math.ceil(seconds);
}
export async function renestLayout(design:Design,quantity:number,current:LayoutSheet[],state:LayoutAdjustments,options:NestOptions={}):Promise<LayoutSheet[]> {
 if(current.some(s=>s.parts.some(p=>p.design&&!p.locked&&!p.extra)))return renestEditedParts(design,quantity,current,state,options);
 const start=performance.now(),budget=options.budget_ms ?? 3000,searchBudget=budget-Math.min(750,budget/4);
 const fixed=current.flatMap(s=>s.parts.filter(p=>p.locked||p.extra).map(p=>({sheet:s.id,part:p})));
 const fixedIds=new Set(fixed.filter(f=>!f.part.extra).map(f=>f.part.number));
 const identities=Array.from({length:quantity},(_,i)=>i+1).filter(n=>!fixedIds.has(n));
 const result:LayoutSheet[]=[];let remaining=identities.length;
 const constrained=Object.keys(state.limits).length>0;
 const input=state.sheets.map(s=>({...s,nest_obstacles:[...(s.nest_obstacles??[]),...(state.avoid[s.id]??[]).map(boxOutline),...fixed.filter(f=>f.sheet===s.id).map(f=>partOutline(design,f.part))]}));
 const append=(layouts:LayoutSheet[])=>{for(const s of layouts){for(const p of s.parts)p.number=identities.shift()!;result.push(s);remaining-=s.parts.length;}};
 if(remaining>0&&!constrained)append(await nestOutlines(design,remaining,input,state.spacing_mm,state.kerf_mm,state.rotate,{...options,rotation_step:state.rotation_step,seed:options.seed??state.seed,budget_ms:Math.max(100,Math.floor(searchBudget-Math.ceil(performance.now()-start)))}));
 else for(const s of input) {
  if(!remaining)break;
  const cap=Math.max(0,(state.limits[s.id]??quantity)-fixed.filter(f=>f.sheet===s.id&&!f.part.extra).length);
  if(!cap)continue;
  const left=Math.floor(searchBudget-Math.ceil(performance.now()-start));if(left<100)throw new Error("The preview ran out of time. Optimize harder or use fewer sheet limits.");
  append(await nestOutlines(design,Math.min(cap,remaining),[s],state.spacing_mm,state.kerf_mm,state.rotate,{...options,rotation_step:state.rotation_step,seed:options.seed??state.seed,budget_ms:left,partial:true}));
 }
 if(remaining)throw new Error("The sheet limits leave too little room for all requested parts.");
 for(const f of fixed) {let s=result.find(s=>s.id===f.sheet);if(!s){s={...state.sheets.find(s=>s.id===f.sheet)!,parts:[],remaining:[]};result.push(s);}s.parts.push(structuredClone(f.part));}
 result.sort((a,b)=>state.sheets.findIndex(s=>s.id===a.id)-state.sheets.findIndex(s=>s.id===b.id));
 for(const s of result){s.parts.sort((a,b)=>a.number-b.number);delete s.nest_obstacles;}
 validateAdjustedLayout(design,result,state,quantity);
 return result;
}
export async function layoutAlternatives(design:Design,quantity:number,state:LayoutAdjustments,profiles:Record<string,Profile>,budget=3000):Promise<LayoutAlternative[]> {
 const goals:LayoutGoal[]=["most_parts","fewest_sheets","shortest_time"],results:LayoutAlternative[]=[];const start=performance.now();
 for(const [i,goal] of goals.entries()) {
  const left=budget-Math.ceil(performance.now()-start);if(left<100&&results.length)break;
  const sheets=goal==="fewest_sheets"?[...state.sheets].sort((a,b)=>b.width*b.height-a.width*a.height):state.sheets;
  try {
   let layouts=await renestLayout(design,quantity,[],{...state,sheets},{seed:state.seed+i,budget_ms:Math.max(100,Math.floor(left/(goals.length-i)))});
   if(goal==="shortest_time")layouts=layouts.map(s=>({...s,parts:travelOrder(s.parts)}));
   const used=layouts.reduce((n,s)=>n+s.width*s.height,0),partArea=contourOf(design);
   const area=Math.abs(partArea.reduce((n,a,j)=>{const b=partArea[(j+1)%partArea.length]!;return n+a.x*b.y-a.y*b.x;},0))/2;
   results.push({goal,seed:state.seed+i,sheets:layouts,utilisation:quantity*area/used,estimated_sec:layoutEstimate(design,layouts,profiles)});
  }catch(error){if(!results.length&&i===goals.length-1)throw error;}
 }
 if(!results.length)throw new Error("No complete layout fits these sheets. Add a sheet or reduce the quantity.");
 // Each goal chooses among all completed searches, preserving the winning seed.
 return goals.map(goal=>{const ranked=[...results].sort((a,b)=>goal==="fewest_sheets"?a.sheets.length-b.sheets.length||b.utilisation-a.utilisation:goal==="shortest_time"?a.estimated_sec-b.estimated_sec:Math.max(...b.sheets.map(s=>s.parts.length))-Math.max(...a.sheets.map(s=>s.parts.length))||b.utilisation-a.utilisation);const best=structuredClone(ranked[0]!);best.goal=goal;if(goal==="shortest_time"){best.sheets=best.sheets.map(s=>({...s,parts:travelOrder(s.parts)}));best.estimated_sec=layoutEstimate(design,best.sheets,profiles);}return best;});
}
function travelOrder(parts:Placement[]):Placement[] {
 const left=[...parts],result:Placement[]=[];let last={x:0,y:0};
 while(left.length){let best=0;for(let i=1;i<left.length;i++)if(Math.hypot(left[i]!.x-last.x,left[i]!.y-last.y)<Math.hypot(left[best]!.x-last.x,left[best]!.y-last.y))best=i;const next=left.splice(best,1)[0]!;result.push(next);last=next;}
 return result;
}

async function renestEditedParts(design:Design,quantity:number,current:LayoutSheet[],state:LayoutAdjustments,options:NestOptions):Promise<LayoutSheet[]> {
 const start=performance.now(),budget=options.budget_ms??3000;
 const fixed=current.flatMap(s=>s.parts.filter(p=>p.locked||p.extra).map(part=>({sheet:s.id,part}))),groups=new Map<string,{design:Design;ids:number[]}>();
 const old=new Map(current.flatMap(s=>s.parts.filter(p=>!p.extra).map(p=>[p.number,p] as const)));
 for(let id=1;id<=quantity;id++) {
  if(fixed.some(p=>p.part.number===id&&!p.part.extra))continue;
  const d=old.get(id)?.design??design,key=JSON.stringify(d),group=groups.get(key)??{design:d,ids:[]};group.ids.push(id);groups.set(key,group);
 }
 const placed=[...fixed],result:LayoutSheet[]=[];
 for(const group of groups.values())for(const sheet of state.sheets) {
  if(!group.ids.length)break;
  const cap=Math.max(0,(state.limits[sheet.id]??quantity)-placed.filter(p=>p.sheet===sheet.id&&!p.part.extra).length);if(!cap)continue;
  const left=budget-Math.ceil(performance.now()-start);if(left<100)throw new Error("The preview ran out of time. Optimize harder to re-nest edited shapes.");
  const input={...sheet,nest_obstacles:[...(sheet.nest_obstacles??[]),...(state.avoid[sheet.id]??[]).map(boxOutline),...placed.filter(p=>p.sheet===sheet.id).map(p=>partOutline(design,p.part))]};
  const layouts=await nestOutlines(group.design,Math.min(cap,group.ids.length),[input],state.spacing_mm,state.kerf_mm,state.rotate,{...options,rotation_step:state.rotation_step,budget_ms:left,partial:true});
  for(const s of layouts)for(const p of s.parts){p.number=group.ids.shift()!;p.design=group.design;placed.push({sheet:sheet.id,part:p});}
 }
 if([...groups.values()].some(g=>g.ids.length))throw new Error("The edited parts do not all fit. Add room or optimize harder.");
 for(const sheet of state.sheets){const parts=placed.filter(p=>p.sheet===sheet.id).map(p=>structuredClone(p.part));if(parts.length)result.push({...sheet,parts,remaining:[]});}
 validateAdjustedLayout(design,result,state,quantity);return result;
}

export function pickLayoutAlternative(state:LayoutAdjustments,index:number):LayoutSheet[] {
 const alternative=state.alternatives[index];
 if(!alternative)throw new Error("Choose an available layout.");
 state.selected=index;
 return structuredClone(alternative.sheets);
}
