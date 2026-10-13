import { useRef, useState } from "react";
import type { LaserDesign, LaserLayoutSheet, LaserPlacement } from "../../lib/api";

export function LaserDrawing({ design, parts, width, height, free, used, selected=[], avoid=[], onPart, onMove, onCheckMove, onAvoid, onNudge }: { design: LaserDesign; parts: LaserPlacement[]; width: number; height: number; free?: LaserLayoutSheet["free_rectangles"]; used?: LaserLayoutSheet["used_outlines"]; selected?:number[]; avoid?:Array<{x:number;y:number;width:number;height:number}>; onPart?:(number:number)=>void; onMove?:(number:number,x:number,y:number)=>void; onCheckMove?:(number:number,x:number,y:number)=>Promise<void>; onAvoid?:(r:{x:number;y:number;width:number;height:number})=>void; onNudge?:(number:number,dx:number,dy:number)=>void }) {
 const [drag,setDrag]=useState<{number:number;start:{x:number;y:number};x:number;y:number;valid:boolean|null;reason?:string}|null>(null);
 const [box,setBox]=useState<{start:{x:number;y:number};end:{x:number;y:number}}|null>(null);
 const checking=useRef(false),generation=useRef(0),lastDrag=useRef(drag);
 const path = (p: LaserDesign["paths"][number]) => {
  const first = p.points[0]; if (!first) return "";
  let d = `M${first.x} ${first.y}`;
  for (let i = 0; i < p.points.length - (p.closed ? 0 : 1); i++) {
   const a = p.points[i]!, b = p.points[(i + 1) % p.points.length]!;
   d += p.curves?.[i] && a.c1 && b.c0 ? `C${a.c1.x} ${a.c1.y} ${b.c0.x} ${b.c0.y} ${b.x} ${b.y}` : `L${b.x} ${b.y}`;
  }
  return d + (p.closed ? "Z" : "");
 };
 const coordinates=(event:React.PointerEvent<SVGElement>)=>{
  const svg=event.currentTarget instanceof SVGSVGElement?event.currentTarget:event.currentTarget.ownerSVGElement!;
  const matrix=svg.getScreenCTM();if(!matrix)return {x:0,y:0};
  const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
  return {x:point.x,y:height-point.y};
 };
 const drawn=box?{x:Math.min(box.start.x,box.end.x),y:Math.min(box.start.y,box.end.y),width:Math.abs(box.end.x-box.start.x),height:Math.abs(box.end.y-box.start.y)}:null;
 return <figure className="space-y-2"><svg viewBox={`0 0 ${width} ${height}`} role={onPart?"group":"img"} aria-label="Nested parts within the sheet's free area" className="w-full max-h-96 rounded border border-line bg-subtle" style={{touchAction:onAvoid?"none":undefined,cursor:onAvoid?"crosshair":undefined}}
  onPointerDown={event=>{if(onAvoid){const start=coordinates(event);setBox({start,end:start});event.currentTarget.setPointerCapture(event.pointerId);}}}
  onPointerMove={event=>{
   const p=coordinates(event);if(box){setBox({...box,end:p});return;}
   const current=lastDrag.current;if(!current)return;
   const part=parts.find(p=>p.number===current.number)!;
   const next={...current,x:part.x+p.x-current.start.x,y:part.y+p.y-current.start.y,valid:null};
   lastDrag.current=next;setDrag(next);const version=++generation.current;
   if(onCheckMove&&!checking.current){checking.current=true;void (async()=>{
    let candidate=next,checkVersion=version;
    while(lastDrag.current){
     let valid=true,reason:string|undefined;
     try{await onCheckMove(candidate.number,candidate.x,candidate.y);}catch(error){valid=false;reason=error instanceof Error?error.message:"This move is not allowed.";}
     if(generation.current===checkVersion){const checked={...candidate,valid,reason};lastDrag.current=checked;setDrag(checked);break;}
     if(!lastDrag.current)break;candidate={...lastDrag.current,valid:null};checkVersion=generation.current;
    }
   })().finally(()=>{checking.current=false;});}

  }}
  onPointerUp={()=>{if(drawn&&onAvoid&&drawn.width>0&&drawn.height>0)onAvoid(drawn);setBox(null);const current=lastDrag.current;generation.current++;lastDrag.current=null;setDrag(null);if(current){const part=parts.find(p=>p.number===current.number)!;if(Math.hypot(current.x-part.x,current.y-part.y)>0.01)onMove?.(current.number,current.x,current.y);}}}
  onPointerCancel={()=>{generation.current++;lastDrag.current=null;setDrag(null);setBox(null);}}>
  <g transform={`translate(0 ${height}) scale(1 -1)`}><rect width={width} height={height} fill="none" stroke="#2563eb" strokeWidth={0.25}/>{free?.map((r,i)=><rect key={i} {...r} fill="none" stroke="#2563eb" strokeWidth={0.25}/>)}{used?.map((p,i)=><polygon key={`used-${i}`} points={p.map(v=>`${v.x},${v.y}`).join(" ")} fill="#64748b" fillOpacity={0.3}/>)}{avoid.map((r,i)=><rect key={`avoid-${i}`} {...r} fill="#ef4444" fillOpacity={0.3} stroke="#ef4444" strokeWidth={0.5}/>)}{drawn&&<rect {...drawn} fill="#ef4444" fillOpacity={0.25} stroke="#ef4444" strokeWidth={0.5}/>}
  {parts.map(p=>{const drawing=p.design??design,transform=p.translation&&p.angle!=null?`translate(${p.translation.x} ${p.translation.y}) rotate(${p.angle})${p.mirrored?" scale(-1 1)":""}`:p.rotated?`translate(${p.x+drawing.height} ${p.y}) rotate(90)`:`translate(${p.x} ${p.y})`;const moving=drag?.number===p.number;
   return <g key={p.number} transform={moving?`translate(${drag.x-p.x} ${drag.y-p.y})`:undefined}><g transform={transform} role={onPart?"button":undefined} {...(onPart?{title:`Part ${p.number}${p.locked?", pinned":""}`}:{})} aria-label={onPart?`Part ${p.number}${p.locked?", pinned":""}`:undefined} aria-pressed={onPart?selected.includes(p.number):undefined} tabIndex={onPart?0:undefined}
    onClick={()=>{if(!onAvoid)onPart?.(p.number);}}
    onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onPart?.(p.number);}const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};const direction=directions[event.key];if(direction&&onNudge){event.preventDefault();onNudge(p.number,...direction);}}}
    onPointerDown={event=>{if(onAvoid||!onMove||event.pointerType==="touch")return;event.stopPropagation();const next={number:p.number,start:coordinates(event),x:p.x,y:p.y,valid:true};lastDrag.current=next;setDrag(next);event.currentTarget.ownerSVGElement!.setPointerCapture(event.pointerId);}}
   >{drawing.paths.map((s,i)=><path key={i} d={path(s)} fill={selected.includes(p.number)?"#f97316":onPart?"#9a3412":"none"} fillOpacity={0.15} stroke={moving?(drag.valid===false?"#ef4444":drag.valid===true?"#16a34a":"#64748b"):"#9a3412"} strokeWidth={selected.includes(p.number)?0.8:0.3}/>)}{p.locked&&<circle cx={drawing.width/2} cy={drawing.height/2} r={Math.min(drawing.width,drawing.height)/8} fill="#2563eb"/>}<title>Part {p.number}{p.locked?", pinned":""}</title></g></g>;
  })}</g></svg>{drag?.reason&&<p role="status" className="text-red-600 dark:text-red-400">{drag.reason}</p>}<figcaption className="text-sm text-muted">Blue outlines show the sheet and free area. Grey areas are already used. Red boxes are areas to avoid. Orange lines show parts; blue dots mark pins.</figcaption></figure>;
}
