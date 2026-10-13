import { createHash } from "node:crypto";
import type { Design, Point } from "./laser-layout.js";

type Fingerprint = { outline:string; area:number; bbox:[number,number]; position:Point; angle:number; offset:Point };
export function geometryFingerprint(paths:Design["paths"]):Fingerprint {
 paths=paths.map(path=>{const points=path.points.map(p=>({...p}));const first=points[0],last=points.at(-1);if(path.closed&&first&&last&&Math.hypot(first.x-last.x,first.y-last.y)<1e-6){if(last.c0)first.c0=last.c0;points.pop();}return {...path,points};});
 const points=paths.flatMap(path=>path.points.flatMap(p=>[p,...(p.c0?[p.c0]:[]),...(p.c1?[p.c1]:[])]));
 if(!points.length||points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error("A shape has invalid geometry.");
 const position={x:Math.min(...points.map(p=>p.x)),y:Math.min(...points.map(p=>p.y))};
 const edges=paths.flatMap(path=>path.points.slice(0,path.closed?undefined:-1).map((p,i)=>{const q=path.points[(i+1)%path.points.length]!;return {length:Math.hypot(q.x-p.x,q.y-p.y),angle:Math.atan2(q.y-p.y,q.x-p.x)};})).filter(edge=>edge.length>1e-6).sort((a,b)=>b.length-a.length);
 const longest=edges[0]?.length??0;
 const angles=[...new Set(edges.filter(edge=>Math.abs(edge.length-longest)<1e-5).slice(0,64).flatMap(edge=>[edge.angle,edge.angle+Math.PI]))];
 const round=(n:number)=>Math.round(n*10000)/10000;
 const variants=angles.map(angle=>{
  const rotate=(p:Point):Point=>({x:(p.x-position.x)*Math.cos(angle)+(p.y-position.y)*Math.sin(angle),y:-(p.x-position.x)*Math.sin(angle)+(p.y-position.y)*Math.cos(angle)});
  const rotated=points.map(rotate),minX=Math.min(...rotated.map(p=>p.x)),minY=Math.min(...rotated.map(p=>p.y));
  const key=(p:Point)=>{const q=rotate(p);return [round(q.x-minX),round(q.y-minY)];};
  const rings=paths.map(path=>{
   const edges=path.points.slice(0,path.closed?undefined:-1).map((p,i)=>{
    const q=path.points[(i+1)%path.points.length]!;
    const controls=path.curves?.[i]?[p.c1??p,q.c0??q]:[];
    const forward=[p,...controls,q].map(key),backward=[q,...[...controls].reverse(),p].map(key);
    return [JSON.stringify(forward),JSON.stringify(backward)].sort()[0]!;
   }).sort();
   return `${path.closed?"closed":"open"}:${edges.join(";")}`;
  }).sort();
  const bbox:[number,number]=[round(Math.max(...rotated.map(p=>p.x))-minX),round(Math.max(...rotated.map(p=>p.y))-minY)];
  const area=round(paths.reduce((total,path)=>total+(path.closed?Math.abs(path.points.reduce((sum,p,i)=>{const q=path.points[(i+1)%path.points.length]!;return sum+p.x*q.y-q.x*p.y;},0))/2:0),0));
  return {outline:rings.join("|"),area,bbox,position,angle,offset:{x:minX,y:minY}};
 });
 if(!variants.length)throw new Error("A shape has no outline to match.");
 return variants.sort((a,b)=>a.outline.localeCompare(b.outline))[0]!;
}
export function fingerprintKey(fingerprint:Fingerprint):string {
 return createHash("sha256").update(JSON.stringify([fingerprint.outline,fingerprint.area,fingerprint.bbox])).digest("hex");
}
