import polygonClipping from "polygon-clipping";
import { canRecordCuts, type Design, type Sheet, type LayoutSheet, type Point, type Rect, subtractRectangles } from "./laser-layout.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { runNestWorker, type NestResult } from "./nesting-pool.js";
import { countOf } from "@cobblr/platform-contract/plural";
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
/** What a nest must keep clear of on a sheet: the sheet minus its usable
 *  leftover, with each hole in a region as an obstacle too. A plain list, so a
 *  caller can append locked parts or areas to avoid before the cap check. An
 *  older reading falls back to its used outlines, then to the complement of
 *  its free rectangles. A cut recorded by hand with kerf and spacing already
 *  keeps half of them around it in the leftover, and the nest adds its full
 *  separation on top: deliberately on the safe side, a few tenths of a
 *  millimetre of waste beside such a cut. A nest's own footprints carry no
 *  margin, so parts beside them sit exactly as before. */
export function sheetObstacles(s: Sheet): Point[][] {
 const whole: polygonClipping.Polygon = [[[0,0],[s.width,0],[s.width,s.height],[0,s.height],[0,0]]];
 if (s.free_regions) {
  const ring = (p: Point[]): polygonClipping.Ring => [...p,p[0]!].map(v=>[v.x,v.y]);
  const regions: polygonClipping.MultiPolygon = s.free_regions.filter(r=>r.length && r[0]!.length>=3).map(r=>r.map(ring));
  // Everything that is not left, holes in a region included.
  const outside = regions.length ? polygonClipping.difference(whole, regions) : [whole];
  return outside.flatMap(simplePieces).map(r=>r.slice(0,-1).map(([x,y])=>({x:x!,y:y!})));
 }
 if (s.used_outlines) return s.used_outlines;
 let unused = [{x:0,y:0,width:s.width,height:s.height}];
 for (const r of s.free_rectangles) {
  if (![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>s.width+1e-6||r.y+r.height>s.height+1e-6) throw new Error("The sheet's free rectangles are invalid.");
  unused = unused.flatMap(a=>subtract(a,r));
 }
 return unused.map(boxPoints);
}
const ringArea = (r: polygonClipping.Ring) => Math.abs(r.reduce((n, v, i) => { const w = r[(i + 1) % r.length]!; return n + v[0] * w[1] - v[1] * w[0]; }, 0)) / 2;
/** A polygon with holes as simple polygons the engine takes: cut into bands
 *  at each hole's top and bottom, every hole spans its band, so each band
 *  piece has none. */
function simplePieces(poly: polygonClipping.Polygon): polygonClipping.Ring[] {
 if (poly.length === 1) return [poly[0]!];
 const ys = poly[0]!.map(v=>v[1]), top = Math.max(...ys), bottom = Math.min(...ys);
 const cuts = [...new Set([bottom, ...poly.slice(1).flatMap(h=>[Math.min(...h.map(v=>v[1])), Math.max(...h.map(v=>v[1]))]), top])].sort((a,b)=>a-b);
 const xs = poly[0]!.map(v=>v[0]), left = Math.min(...xs) - 1, right = Math.max(...xs) + 1;
 const out: polygonClipping.Ring[] = [];
 for (let i = 1; i < cuts.length; i++) {
  const band: polygonClipping.Polygon = [[[left,cuts[i-1]!],[right,cuts[i-1]!],[right,cuts[i]!],[left,cuts[i]!],[left,cuts[i-1]!]]];
  for (const piece of polygonClipping.intersection(poly, band)) {
   if (piece.length > 1) throw new Error("This sheet's leftover is too intricate to nest by outline.");
   // A cut along a band edge can leave a sliver with no area; it would only
   // count against the obstacle cap.
   if (ringArea(piece[0]!) > 1e-6) out.push(piece[0]!);
  }
 }
 return out;
}
const boxPoints = (r: Rect): Point[] => [{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}];
const nesting = new URL("../nesting/", import.meta.url);
let warned = false;
/** The engine is a git-ignored build, and without it every outline nest came
 *  back as rectangles while saying nothing: a test then failed as "room for 1
 *  of 2 parts" (#5419). A build copied from an older checkout failed the same
 *  quiet way, since the engine ignores inputs it does not know. A test is told
 *  what to run; a running api, whose image builds its own, says it once. */
/** What a sheet nested without the engine says, to the person looking at it. */
export const ENGINE_MISSING_NOTE = "Nested by rectangle: the outline nesting engine is not installed on this server, so parts are spaced by their bounding boxes and use more of the sheet.";
function engineMissing(): boolean {
 const run = "Run scripts/build-nesting.sh.";
 if (existsSync(new URL("pkg/cobblr_nesting.cjs", nesting))) {
  if (process.env.VITEST && builtFrom() !== sourceHash()) throw new Error(`The outline nesting engine was built from other sources than this checkout's. ${run}`);
  return false;
 }
 const message = `The outline nesting engine is not built (modules/digifab/nesting/pkg is missing). ${run}`;
 if (process.env.VITEST) throw new Error(message);
 if (!warned) { warned = true; console.error(message); }
 return true;
}
function builtFrom(): string | null {
 try { return readFileSync(new URL("pkg/source.sha256", nesting), "utf8").trim(); } catch { return null; }
}
function sourceHash(): string {
 const hash = createHash("sha256");
 for (const file of ["Cargo.toml", "Cargo.lock", "src/lib.rs"]) hash.update(readFileSync(new URL(file, nesting)));
 return hash.digest("hex");
}
export async function nestOutlines(design: Design, quantity: number, sheets: Sheet[], spacing: number, kerf: number, rotate: boolean, options: NestOptions = {}): Promise<LayoutSheet[]> {
 const budget = options.budget_ms ?? 3000, step = options.rotation_step ?? (rotate ? 90 : 360), seed = options.seed ?? 0;
 if (!Number.isInteger(budget) || budget < 100 || budget > 30000 || !Number.isInteger(step) || step < 1 || step > 360 || 360 % step || !Number.isSafeInteger(seed) || seed < 0) throw new Error("Use a time budget from 100 to 30,000 ms, a rotation step that divides 360 and a nonnegative seed.");
 if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || ![design.width,design.height].every(n=>Number.isFinite(n)&&n>0) || ![spacing,kerf].every(n=>Number.isFinite(n)&&n>=0&&n<=100) || !sheets.length || sheets.length > 50) throw new Error("Give valid part sizes, sheets, spacing, kerf and a quantity up to 10,000.");
 let outline: ReturnType<typeof designOutline> = null;
 try { outline = designOutline(design); } catch { /* A complex contour can still use the rectangle planner. */ }
 const started = performance.now();
 // The sheet's free rectangles already exclude every used area. Subtracting the BOUNDS of a used outline again removed an L-shaped offcut's free notch (its bounds are the whole sheet).
 const extraObstacles = sheets.map(s => [...sheetObstacles(s), ...(s.nest_obstacles ?? [])]);
 for (const obstacles of extraObstacles) if (obstacles.length > 512 || obstacles.reduce((n,p)=>n+p.length,0)>32768) throw new Error("This sheet is too fragmented to nest by outline.");
 const rectangleSheets = sheets.map(s => {
  const margin = (spacing + kerf) / 2;
  let free = s.free_rectangles;
  for (const obstacle of s.nest_obstacles ?? []) {
   const b = bounds(obstacle);
   free = subtractRectangles(free, {x:b.x-margin,y:b.y-margin,width:b.width+2*margin,height:b.height+2*margin});
  }
  if(s.nest_obstacles?.length) free = free.map(r=>({x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(s.width,r.x+r.width)-Math.max(0,r.x)-1e-9,height:Math.min(s.height,r.y+r.height)-Math.max(0,r.y)-1e-9})).filter(r=>r.width>0&&r.height>0);
  return {...s,free_rectangles:free};
 });
 const rectangle = runNestWorker<LayoutSheet[]>({rectangle:{design,quantity,sheets:rectangleSheets,spacing,kerf,rotate:rotate && step !== 360 && 90 % step === 0,partial:options.partial}},Math.max(1,budget-Math.ceil(performance.now()-started))).then(result=>({result}),error=>({error}));
 // A part that is not a plain rectangle, nested by its bounding box, says
 // why on the sheet (#5419): spaced by boxes, its parts cannot touch, but
 // the sheet is used worse than an outline nest would, and a person should
 // know that rather than read it as the best layout there is.
 const fallback = async (why?: string) => { const answer = await rectangle; if ("error" in answer) throw answer.error; if (answer.result.some(s=>!canRecordCuts(s.cut_capacity,s.parts.map(p=>p.footprint)))) throw new Error("This sheet cannot record all these cuts. Use fewer parts or another sheet."); return answer.result.map(s=>({...s, nesting: "rectangle" as const, ...(why ? { nesting_note: why } : {}), nest_ms: Math.round(performance.now()-started), utilisation:s.parts.length*(outline ? area(outline.points) : design.width*design.height)/(s.width*s.height)})); };
 if (!outline || !outline.curved && Math.abs(area(outline.points)-design.width*design.height)<1e-6) return fallback();
 if (engineMissing()) return fallback(ENGINE_MISSING_NOTE);
 const separation = spacing + kerf + (outline.curved ? 0.1 : 0) + Math.max(...sheets.map(s=>Math.max(s.width,s.height)),design.width,design.height)*2e-6;
 const containers = sheets.map((s,id)=>{
  if (![s.width,s.height].every(n=>Number.isFinite(n)&&n>0)) throw new Error("The sheet dimensions are invalid.");
  const obstacles = extraObstacles[id]!;
  return {id,shape:{type:"simple_polygon",data:(s.outline??boxPoints({x:0,y:0,width:s.width,height:s.height})).map(p=>[p.x,p.y])},zones:obstacles.map(p=>({quality:0,shape:{type:"simple_polygon",data:p.map(v=>[v.x,v.y])}}))};
 });
 const start = performance.now();
 try {
  const result = await runNestWorker<NestResult>({ item:{id:0,orientation:{rotation:{mode:"stepped",step:rotate?step:360}},shape:{type:"simple_polygon",data:outline.points.map(p=>[p.x,p.y])}}, containers, quantity, separation, seed, attempts:Math.min(budget>3000?32:8,Math.max(quantity<=16?2:1,Math.floor((budget>3000?1024:256)/(quantity*outline.points.length)))), samples:budget>3000?4000:1000 },Math.max(1,budget - Math.ceil(performance.now()-started) - 10));
  if (!options.partial && result.placed !== quantity) return fallback(`Nested by rectangle: the outline search fitted ${result.placed} of ${countOf(quantity, "part")} in the time it had. Optimize harder may fit them by outline.`);
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
  if (outlineLayouts.some(s=>!canRecordCuts(s.cut_capacity,[],s.parts.map(p=>p.footprint_outline!)))) return fallback("Nested by rectangle: this sheet cannot record the parts' outlines as cuts.");
  if (options.partial) {const boxes=await rectangle;if("result" in boxes && boxes.result.reduce((n,s)=>n+s.parts.length,0)>result.placed)return fallback("Nested by rectangle: by bounding box, more parts fit than the outline search placed.");}
  return outlineLayouts;
 } catch (e) {
  // The search not finishing, or refusing a shape, is a reason to nest by
  // rectangle, and the sheet says which. A mistake in this code (a TypeError
  // on a malformed answer) is not a hard layout, and is never passed off as one.
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) throw e;
  return fallback(`Nested by rectangle: the outline search did not finish (${e instanceof Error ? e.message : String(e)}).`);
 }
}
function subtract(a: Rect, b: Rect): Rect[] {
 if (a.x>=b.x+b.width||b.x>=a.x+a.width||a.y>=b.y+b.height||b.y>=a.y+a.height) return [a];
 const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),top=Math.min(a.y+a.height,b.y+b.height);
 return [{x:a.x,y:a.y,width:x-a.x,height:a.height},{x:right,y:a.y,width:a.x+a.width-right,height:a.height},{x,y:a.y,width:right-x,height:y-a.y},{x,y:top,width:right-x,height:a.y+a.height-top}].filter(r=>r.width>0&&r.height>0);
}
