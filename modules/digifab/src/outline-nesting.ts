import { canRecordCuts, type Design, type Sheet, type LayoutSheet, type Point, type Rect } from "./laser-layout.js";
import { runNestWorker, type NestResult } from "./nesting-pool.js";
export type NestOptions = { rotation_step?: number; budget_ms?: number; seed?: number; partial?: boolean };
const bounds = (points: Point[]): Rect => {
 const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
 return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y };
};
const area = (p: Point[]) => Math.abs(p.reduce((n, a, i) => { const b = p[(i + 1) % p.length]!; return n + a.x * b.y - a.y * b.x; }, 0)) / 2;
const inside = (p: Point, polygon: Point[]) => {
 let odd = false;
 for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
  const a = polygon[i]!, b = polygon[j]!;
  const cross = (p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x);
  if (Math.abs(cross) < 1e-6 && p.x >= Math.min(a.x,b.x)-1e-6 && p.x <= Math.max(a.x,b.x)+1e-6 && p.y >= Math.min(a.y,b.y)-1e-6 && p.y <= Math.max(a.y,b.y)+1e-6) return true;
  if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) odd = !odd;
 }
 return odd;
};
export function designOutline(design: Design): { points: Point[]; curved: boolean } | null {
 const flat = design.paths.map(path => {
  const points: Point[] = [];
  for (let i=0; i<path.points.length-(path.closed?0:1); i++) {
   const a=path.points[i]!, b=path.points[(i+1)%path.points.length]!;
   points.push({x:a.x,y:a.y});
   if (path.curves?.[i] && a.c1 && b.c0) {
    const length = Math.hypot(a.c1.x-a.x,a.c1.y-a.y)+Math.hypot(b.c0.x-a.c1.x,b.c0.y-a.c1.y)+Math.hypot(b.x-b.c0.x,b.y-b.c0.y);
    // The control polygon bounds curvature error; short steps reserve 0.05 mm below.
    const count = Math.ceil(Math.sqrt(Math.max(1, length * 6 / 0.025)));
    if (count > 2048) throw new Error("This curve is too complex to nest by outline.");
    for (let j=1;j<count;j++) { const t=j/count,u=1-t; points.push({x:u**3*a.x+3*u*u*t*a.c1.x+3*u*t*t*b.c0.x+t**3*b.x,y:u**3*a.y+3*u*u*t*a.c1.y+3*u*t*t*b.c0.y+t**3*b.y}); }
   }
  }
  if (!path.closed && path.points.length) points.push(path.points[path.points.length-1]!);
  return { points, closed: path.closed, curved: !!path.curves?.some(Boolean) };
 });
 const outer = flat.filter(p => p.closed && p.points.length >= 3).sort((a,b)=>area(b.points)-area(a.points))[0];
 if (!outer || !flat.every(p=>p.points.every(v=>inside(v,outer.points)))) return null;
 return outer;
}
const boxPoints = (r: Rect): Point[] => [{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];
export async function nestOutlines(design: Design, quantity: number, sheets: Sheet[], spacing: number, kerf: number, rotate: boolean, options: NestOptions = {}): Promise<LayoutSheet[]> {
 const budget = options.budget_ms ?? 3000, step = options.rotation_step ?? (rotate ? 90 : 360), seed = options.seed ?? 0;
 if (!Number.isInteger(budget) || budget < 100 || budget > 30000 || !Number.isInteger(step) || step < 1 || step > 360 || 360 % step || !Number.isSafeInteger(seed) || seed < 0) throw new Error("Use a time budget from 100 to 30,000 ms, a rotation step that divides 360 and a nonnegative seed.");
 if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || ![design.width,design.height].every(n=>Number.isFinite(n)&&n>0) || ![spacing,kerf].every(n=>Number.isFinite(n)&&n>=0&&n<=100) || !sheets.length || sheets.length > 50) throw new Error("Give valid part sizes, sheets, spacing, kerf and a quantity up to 10,000.");
 let outline: ReturnType<typeof designOutline> = null;
 try { outline = designOutline(design); } catch { /* A complex contour can still use the rectangle planner. */ }
 const started = performance.now();
 // The sheet's free rectangles already exclude every used area. Subtracting the BOUNDS of a used outline again removed an L-shaped offcut's free notch (its bounds are the whole sheet).
 const rectangleSheets = sheets;
 const rectangle = runNestWorker<LayoutSheet[]>({rectangle:{design,quantity,sheets:rectangleSheets,spacing,kerf,rotate:rotate && step !== 360 && 90 % step === 0,partial:options.partial}},Math.max(1,budget-Math.ceil(performance.now()-started))).then(result=>({result}),error=>({error}));
 const fallback = async () => { const answer = await rectangle; if ("error" in answer) throw answer.error; if (answer.result.some(s=>!canRecordCuts(s.cut_capacity,s.parts.map(p=>p.footprint)))) throw new Error("This sheet cannot record all these cuts. Use fewer parts or another sheet."); return answer.result.map(s=>({...s, nesting: "rectangle" as const, nest_ms: Math.round(performance.now()-started), utilisation:s.parts.length*(outline ? area(outline.points) : design.width*design.height)/(s.width*s.height)})); };
 if (!outline || !outline.curved && Math.abs(area(outline.points)-design.width*design.height)<1e-6) return fallback();
 const separation = spacing + kerf + (outline.curved ? 0.1 : 0) + Math.max(...sheets.map(s=>Math.max(s.width,s.height)),design.width,design.height)*2e-6;
 const containers = sheets.map((s,id)=>{
  if (![s.width,s.height].every(n=>Number.isFinite(n)&&n>0)) throw new Error("The sheet dimensions are invalid.");
  let unused = [{x:0,y:0,width:s.width,height:s.height}];
  // Legacy sheets expose maximal free rectangles. Their complement is the obstacle set.
  for (const r of s.free_rectangles) {
   if (![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>s.width+1e-6||r.y+r.height>s.height+1e-6) throw new Error("The sheet's free rectangles are invalid.");
   unused = unused.flatMap(a=>subtract(a,r));
  }
  const obstacles = s.used_outlines ?? unused.map(boxPoints);
  if (obstacles.length>512 || obstacles.reduce((n,p)=>n+p.length,0)>32768) throw new Error("This sheet is too fragmented to nest by outline.");
  return {id,shape:{type:"simple_polygon",data:(s.outline??boxPoints({x:0,y:0,width:s.width,height:s.height})).map(p=>[p.x,p.y])},zones:obstacles.map(p=>({quality:0,shape:{type:"simple_polygon",data:p.map(v=>[v.x,v.y])}}))};
 });
 const start = performance.now();
 try {
  const result = await runNestWorker<NestResult>({ item:{id:0,orientation:{rotation:{mode:"stepped",step:rotate?step:360}},shape:{type:"simple_polygon",data:outline.points.map(p=>[p.x,p.y])}}, containers, quantity, separation, seed, attempts:Math.min(budget>3000?32:8,Math.max(quantity<=16?2:1,Math.floor((budget>3000?1024:256)/(quantity*outline.points.length)))), samples:budget>3000?4000:1000 },Math.max(1,budget - Math.ceil(performance.now()-started) - 10));
  if (!options.partial && result.placed !== quantity) return fallback();
  let number=0;
  const outlineLayouts = result.layouts.flatMap((l,i)=>{
   const sheet=sheets[l.container_id]!;
   if (!l.placed_items.length) return [];
   const parts=l.placed_items.map((p,j)=>{
    const footprint_outline=result.outlines[i]![j]!.map(([x,y])=>({x,y}));
    if (footprint_outline.length>256) throw new Error("This contour has too many vertices to record its used area.");
    const angle=p.transformation.rotation, [tx,ty]=p.transformation.translation, rad=angle*Math.PI/180;
    const actual=bounds(outline!.points.map(v=>({x:tx+v.x*Math.cos(rad)-v.y*Math.sin(rad),y:ty+v.x*Math.sin(rad)+v.y*Math.cos(rad)})));
    return {...actual,number:++number,rotated:Math.abs(angle)%180>1e-5,angle,translation:{x:tx,y:ty},footprint:bounds(footprint_outline),footprint_outline};
   });
   return [{...sheet,parts,remaining:[],nesting:"outline" as const,nest_ms:Math.round(performance.now()-start),utilisation:parts.length*area(outline!.points)/(sheet.width*sheet.height)}];
  });
  if (outlineLayouts.some(s=>!canRecordCuts(s.cut_capacity,[],s.parts.map(p=>p.footprint_outline!)))) return fallback();
  if (options.partial) {const boxes=await rectangle;if("result" in boxes && boxes.result.reduce((n,s)=>n+s.parts.length,0)>result.placed)return fallback();}
  return outlineLayouts;
 } catch { return fallback(); }
}
function subtract(a: Rect, b: Rect): Rect[] {
 if (a.x>=b.x+b.width||b.x>=a.x+a.width||a.y>=b.y+b.height||b.y>=a.y+a.height) return [a];
 const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),top=Math.min(a.y+a.height,b.y+b.height);
 return [{x:a.x,y:a.y,width:x-a.x,height:a.height},{x:right,y:a.y,width:a.x+a.width-right,height:a.height},{x,y:a.y,width:right-x,height:y-a.y},{x,y:top,width:right-x,height:a.y+a.height-top}].filter(r=>r.width>0&&r.height>0);
}
