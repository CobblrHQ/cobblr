import { z } from "zod";
import { transformPlacedPoint, orderedLaserLayers, type Design, type LayoutSheet, type LayerSettings, type Point, type Profile, type Rect } from "../../laser-layout.js";

const position = z.object({ x: z.number().finite(), y: z.number().finite() });
export const LaserMotionPlanSchema = z.object({
 version: z.literal(1), origin: z.literal("lower-left"),
 bed: z.object({width:z.number().positive().finite(),height:z.number().positive().finite()}),
 sheet: z.object({width:z.number().positive().finite(),height:z.number().positive().finite()}),
 bounds: z.object({x:z.number().nonnegative().finite(),y:z.number().nonnegative().finite(),width:z.number().nonnegative().finite(),height:z.number().nonnegative().finite()}),
 layers: z.array(z.object({index:z.number().int().nonnegative(),layer:z.string(),operation:z.enum(["cut","score","engrave"]),material:z.string(),thickness_mm:z.number().positive(),speed:z.number().positive().max(10000),min_power:z.number().min(0).max(100),max_power:z.number().min(0).max(100),passes:z.number().int().min(1).max(100),air_assist:z.boolean(),focus_offset:z.number().min(-100).max(100),return_to_origin:z.boolean().optional()})).min(1).max(30),
 paths: z.array(z.object({layer_index:z.number().int().nonnegative(),points:z.array(position).min(2).max(200000)})).min(1).max(200000),
});
export type LaserMotionPlan = z.infer<typeof LaserMotionPlanSchema>;
const midpoint = (a:Point,b:Point):Point => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
function flatten(a:Point,c:Point,d:Point,b:Point,out:Point[],depth=0):void {
 const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
 const deviation = length ? Math.max(Math.abs(dy*(c.x-a.x)-dx*(c.y-a.y)),Math.abs(dy*(d.x-a.x)-dx*(d.y-a.y)))/length : Math.max(Math.hypot(c.x-a.x,c.y-a.y),Math.hypot(d.x-a.x,d.y-a.y));
 const excess = Math.hypot(c.x-a.x,c.y-a.y)+Math.hypot(d.x-c.x,d.y-c.y)+Math.hypot(b.x-d.x,b.y-d.y)-length;
 if(deviation<=0.02 && excess<=0.02) {out.push(b);return;}
 if(depth>=18 || out.length>=200000) throw new Error("This curve exceeds the laser plan's precision budget.");
 const ac=midpoint(a,c),cd=midpoint(c,d),db=midpoint(d,b),left=midpoint(ac,cd),right=midpoint(cd,db),mid=midpoint(left,right);
 flatten(a,ac,left,mid,out,depth+1); flatten(mid,right,db,b,out,depth+1);
}
function linearPath(path:Design["paths"][number],transform:(p:Point)=>Point):Point[] {
 if(path.points.length<2) throw new Error("A laser path needs at least two points.");
 const points=[transform(path.points[0]!)];
 for(let i=0;i<path.points.length-(path.closed?0:1);i++) {
  const a=path.points[i]!,b=path.points[(i+1)%path.points.length]!;
  if(path.curves?.[i]) {if(!a.c1||!b.c0) throw new Error("A curve is missing its control points.");flatten(transform(a),transform(a.c1),transform(b.c0),transform(b),points);}
  else points.push(transform(b));
 }
 return points;
}
function area(points:Point[]):number {return Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length]!;return sum+p.x*q.y-q.x*p.y;},0))/2;}
function fillContours(contours:Point[][]):Point[][] {
 const b=motionBounds(contours.map(points=>({layer_index:0,points}))),lo=b.y,hi=b.y+b.height,lines:Point[][]=[];
 if((hi-lo)/0.1>200000) throw new Error("This engraving exceeds the laser plan's size limit.");
 for(let row=0,y=lo+0.05;y<hi;row++,y=lo+0.05+row*0.1) {
  const xs:number[]=[];
  for(const points of contours) for(let i=0;i<points.length-1;i++) {const a=points[i]!,b=points[i+1]!;if((a.y<=y&&b.y>y)||(b.y<=y&&a.y>y))xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));}
  xs.sort((a,b)=>a-b);
  if(xs.length%2) throw new Error("This engraving has an open contour.");
  const segments:Point[][]=[];
  for(let i=0;i<xs.length;i+=2) if(xs[i+1]!-xs[i]!>0.000001) segments.push([{x:xs[i]!,y},{x:xs[i+1]!,y}]);
  if(row%2) {segments.reverse();for(const s of segments)s.reverse();}
  lines.push(...segments);
 }
 return lines;
}
export function validateLaserPlan(raw:unknown):LaserMotionPlan {
 const plan=LaserMotionPlanSchema.parse(raw);
 let count=0;
 for(const path of plan.paths) {
  if(!plan.layers.some(l=>l.index===path.layer_index)) throw new Error("The laser plan refers to a missing layer.");
  count+=path.points.length;if(count>200000)throw new Error("This laser plan has too many motion points.");
  for(const p of path.points) {
   if(p.x<0||p.y<0||p.x>plan.sheet.width||p.y>plan.sheet.height)throw new Error("The job does not fit the loaded sheet.");
   if(p.x>plan.bed.width||p.y>plan.bed.height)throw new Error("The job does not fit the saved bed.");
  }
 }
 const bounds=motionBounds(plan.paths);
 if(Object.keys(bounds).some(k=>Math.abs(bounds[k as keyof Rect]-plan.bounds[k as keyof Rect])>0.000001))throw new Error("The laser plan's bounds changed.");
 return plan;
}
export function compileLaserPlan(design:Design,sheet:LayoutSheet,profiles:Record<string,Profile>,bed:{width:number;height:number}):LaserMotionPlan {
 const layers:LayerSettings[]=orderedLaserLayers(design,profiles);
 const paths:LaserMotionPlan["paths"]=[];
 for(const layer of layers) for(const part of sheet.parts) {
  const transform=(p:Point):Point=>transformPlacedPoint(p,part,(part.design ?? design).height);
  const source=(part.design ?? design).paths.filter(p=>p.layer===layer.layer);
  const contours=source.map(p=>({closed:p.closed,points:linearPath(p,transform)}));
  if(layer.operation==="engrave") {
   if(contours.some(p=>!p.closed))throw new Error("Close every engraving contour before using a fill profile.");
   paths.push(...fillContours(contours.map(p=>p.points)).map(points=>({layer_index:layer.index,points})));
  } else {
   if(layer.operation==="cut")contours.sort((a,b)=>(a.closed?area(a.points):0)-(b.closed?area(b.points):0));
   paths.push(...contours.map(p=>({layer_index:layer.index,points:p.points})));
  }
 }
 const bounds=motionBounds(paths);
 return validateLaserPlan({version:1,origin:"lower-left",bed,sheet:{width:sheet.width,height:sheet.height},layers,paths,bounds});
}

function motionBounds(paths:LaserMotionPlan["paths"]):Rect {
 let x=Infinity,y=Infinity,right=-Infinity,top=-Infinity;
 for(const path of paths)for(const point of path.points){x=Math.min(x,point.x);y=Math.min(y,point.y);right=Math.max(right,point.x);top=Math.max(top,point.y);}
 return {x,y,width:right-x,height:top-y};
}
