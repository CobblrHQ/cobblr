import { fingerprintKey, geometryFingerprint } from "../../layout-fingerprint.js";
import { countOf } from "@cobblr/platform-contract/plural";
import { SaxesParser } from "saxes";
import { normalise, parseDxf, parseSvg, transformPaths } from "./laser-design.js";
import { generateNestedSvg, generateProject, transformPlacedPoint, type Design, type LayoutSheet, type Placement, type Point, type Profile } from "../../laser-layout.js";
import { outlineBounds, partOutline, validateAdjustedLayout, type LayoutAdjustments } from "../../layout-adjustments.js";

export function exportLayout(design:Design,sheet:LayoutSheet,format:"svg"|"dxf"|"lightburn",profiles:Record<string,Profile>):string {
 const fingerprints=new Map(sheet.parts.map(part=>[part.number,fingerprintKey(geometryFingerprint((part.design??design).paths))]));
 if(format==="lightburn")return generateProject(design,sheet,profiles).xml.replace(/Name="cobblr-part-(\d+)"/g,(name,id:string)=>`${name} CobblrFingerprint="${fingerprints.get(Number(id))}"`);
 if(format==="svg")return generateNestedSvg(design,sheet).replace(/data-part-id="(\d+)"/g,(id,number:string)=>`${id} data-cobblr-fingerprint="${fingerprints.get(Number(number))}"`);
 const pairs:Array<[number,string|number]>=[[0,"SECTION"],[2,"HEADER"],[9,"$INSUNITS"],[70,4],[0,"ENDSEC"],[0,"SECTION"],[2,"ENTITIES"]];
 for(const part of sheet.parts)for(const path of (part.design??design).paths) {
  if(path.curves?.some(Boolean))throw new Error("Use SVG or LightBurn for curved parts. DXF export needs straight paths.");
  const points=path.points.map(p=>transformPlacedPoint(p,part,(part.design??design).height));
  pairs.push([0,"LWPOLYLINE"],[8,path.layer],[1001,"COBBLR"],[1000,`cobblr-part-${part.number}`],[1000,`fingerprint-${fingerprints.get(part.number)}`],[90,points.length],[70,path.closed?1:0]);
  for(const p of points)pairs.push([10,p.x],[20,p.y]);
 }
 pairs.push([0,"ENDSEC"],[0,"EOF"]);
 return pairs.map(([c,v])=>`${c}\n${v}`).join("\n")+"\n";
}
type Imported = { id?:number; paths:Design["paths"] };
function svgParts(content:string,stored:Map<number,Design>):Imported[] {
 const groups=new Set<string>();const parser=new SaxesParser();
 parser.on("opentag",tag=>{const a=tag.attributes as Record<string,string>,id=/^cobblr-(?:part-)?(\d+)$/.exec(a.id??"")?.[1]??a["data-part-id"];if(id){if(groups.has(id))throw new Error("A part ID appears more than once. Keep one object group per part.");groups.add(id);}});parser.write(content).close();
 const grouped=new Map<string,Design["paths"]>();let extra=0;
 parseSvg(content,(paths,id)=>{const key=id??`extra-${extra++}`;grouped.set(key,[...(grouped.get(key)??[]),...paths]);},true,id=>stored.get(Number(id))?.paths);
 return [...grouped].map(([id,paths])=>({...( /^\d+$/.test(id)?{id:Number(id)}:{}),paths}));
}
function dxfParts(content:string):Imported[] {
 const lines=content.split(/\r?\n/),pairs:Array<[number,string]>=[];
 for(let i=0;i+1<lines.length;i+=2)pairs.push([Number(lines[i]),lines[i+1]!.trim()]);
 const units=pairs.findIndex(([c,v])=>c===9&&v==="$INSUNITS");
 if(units<0||Number(pairs[units+1]?.[1])!==4)throw new Error("Export the edited DXF in millimetres with its unit saved.");
 const grouped=new Map<string,Design["paths"]>();let extra=0,entities=false;
 for(let i=0;i<pairs.length;i++) {
  if(pairs[i]?.[0]!==0)continue;let j=i+1;while(j<pairs.length&&pairs[j]![0]!==0)j++;
  const kind=pairs[i]![1],codes=pairs.slice(i+1,j);
  if(kind==="SECTION"){entities=codes.some(([c,v])=>c===2&&v==="ENTITIES");continue;}
  if(kind==="ENDSEC"){entities=false;continue;}
  if(!entities)continue;
  const id=codes.find(([c,v])=>c===1000&&/^cobblr-part-\d+$/.test(v))?.[1].replace("cobblr-part-","")??`extra-${extra++}`;
  const entity=[[0,kind] as [number,string],...codes.filter(([c])=>c!==1000&&c!==1001)];
  const text=`0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entity.map(([c,v])=>`${c}\n${v}`).join("\n")}\n0\nENDSEC\n0\nEOF\n`;
  // Recover the original lower-left coordinates after the standard importer normalises them.
  const design=parseDxf(text),x=Number(codes.find(([c])=>c===10)?.[1]),y=Number(codes.find(([c])=>c===20)?.[1]);
  if(kind!=="LWPOLYLINE"&&kind!=="LINE")throw new Error("Use SVG to bring back curves with stable part names.");
  const xs=codes.filter(([c])=>c===10||c===11).map(([,v])=>Number(v)),ys=codes.filter(([c])=>c===20||c===21).map(([,v])=>Number(v));
  const minX=Math.min(x,...xs),minY=Math.min(y,...ys);
  const shift=(p:Point):Point=>({x:p.x+minX,y:p.y+minY});
  const paths=design.paths.map(p=>({...p,points:p.points.map(shift)}));
  grouped.set(id,[...(grouped.get(id)??[]),...paths]);i=j-1;
 }
 return [...grouped].map(([id,paths])=>({...( /^\d+$/.test(id)?{id:Number(id)}:{}),paths}));
}
function lightburnParts(content:string):Imported[] {
 const grouped=new Map<string,Design["paths"]>();let shape:{id:string;layer:string;verts:string;prims:string;transform:string}|null=null,field="",extra=0;
 const parser=new SaxesParser();
 parser.on("doctype",()=>{throw new Error("Document types are not accepted.");});
 parser.on("opentag",tag=>{
  const a=tag.attributes as Record<string,string>;
  if(tag.name==="Shape") {if(shape)throw new Error("Ungroup LightBurn shapes before bringing them back.");if(a.Type!=="Path")throw new Error("Convert LightBurn shapes to paths before bringing them back.");shape={id:/^cobblr-part-\d+$/.test(a.Name??"")?a.Name!.replace("cobblr-part-",""):`extra-${extra++}`,layer:a.CutIndex??"0",verts:"",prims:"",transform:""};}
  if(shape&&["VertList","PrimList","XForm"].includes(tag.name))field=tag.name;
 });
 parser.on("text",text=>{if(!shape)return;if(field==="VertList")shape.verts+=text;if(field==="PrimList")shape.prims+=text;if(field==="XForm")shape.transform+=text;});
 parser.on("closetag",tag=>{
  if(tag.name!=="Shape"){field="";return;}if(!shape)return;
  const vertices=[...shape.verts.matchAll(/V([^V]+)/g)].map(m=>{const v=m[1]!,xy=/^([-+\d.eE]+)\s+([-+\d.eE]+)/.exec(v);if(!xy)throw new Error("A LightBurn vertex is invalid.");const p:Point={x:Number(xy[1]),y:Number(xy[2])};for(const key of ["c0","c1"] as const){const c=new RegExp(`${key}x([-+\\d.eE]+)${key}y([-+\\d.eE]+)`).exec(v);if(c)p[key]={x:Number(c[1]),y:Number(c[2])};}return p;});
  const primitives=[...shape.prims.matchAll(/([LB])(\d+)\s+(\d+)/g)];
  if(!vertices.length||!primitives.length)throw new Error("A LightBurn path has no readable geometry.");
  const matrix=shape.transform.trim().split(/\s+/).map(Number);if(matrix.length!==6||!matrix.every(Number.isFinite))throw new Error("A LightBurn transform is invalid.");
  const tx=(p:Point):Point=>({x:matrix[0]!*p.x+matrix[2]!*p.y+matrix[4]!,y:matrix[1]!*p.x+matrix[3]!*p.y+matrix[5]!});
  const points=vertices.map(p=>({...tx(p),...(p.c0?{c0:tx(p.c0)}:{}),...(p.c1?{c1:tx(p.c1)}:{})}));
  if(primitives.some((m,i)=>Number(m[2])!==i||Number(m[3])!==(i+1)%points.length))throw new Error("Simplify disconnected LightBurn paths before bringing them back.");
  const path={layer:shape.layer,points,closed:primitives.length===points.length,curves:primitives.map(m=>m[1]==="B")};
  grouped.set(shape.id,[...(grouped.get(shape.id)??[]),path]);shape=null;
 });
 parser.write(content).close();return [...grouped].map(([id,paths])=>({...( /^\d+$/.test(id)?{id:Number(id)}:{}),paths}));
}
export function importLayout(design:Design,sheets:LayoutSheet[],state:LayoutAdjustments,quantity:number,sheetId:string,filename:string,content:string,extras:"review"|"keep"|"drop",profiles:Record<string,Profile>,assignments:Record<string,number>={}):{sheets?:LayoutSheet[];unmatched:string[];missing?:number[]} {
 if(Buffer.byteLength(content)>2*1024*1024)throw new Error("Bring back a file up to 2 MB.");
 const original=sheets.find(s=>s.id===sheetId);if(!original)throw new Error("Choose a sheet in this plan.");
 const stored=new Map(original.parts.filter(p=>!p.extra).map(part=>{const drawing=part.design??design;const tx=(p:Point)=>transformPlacedPoint(p,part,drawing.height);return [part.number,{...drawing,paths:drawing.paths.map(path=>({...path,points:path.points.map(p=>({...tx(p),...(p.c0?{c0:tx(p.c0)}:{}),...(p.c1?{c1:tx(p.c1)}:{})}))}))}];}));
 const imported=/\.svg$/i.test(filename)?svgParts(content,stored):/\.dxf$/i.test(filename)?dxfParts(content):/\.lbrn2$/i.test(filename)?lightburnParts(content):null;
 if(!imported)throw new Error("Bring back SVG, DXF or LightBurn project files.");
 const ids=new Set(original.parts.filter(p=>!p.extra).map(p=>p.number));
 const matched=imported.filter(p=>p.id!=null&&ids.has(p.id));
 if(new Set(matched.map(p=>p.id)).size!==matched.length)throw new Error("A part ID appears more than once. Give each part its original name.");
 const expected=original.parts.filter(p=>!p.extra&&!matched.some(item=>item.id===p.number)).map(part=>({part,fingerprint:geometryFingerprint(stored.get(part.number)!.paths)}));
 const anonymous=imported.filter(item=>item.id==null).map(item=>({item,fingerprint:geometryFingerprint(item.paths)}));
 const keys=new Map([...expected,...anonymous].map(candidate=>[candidate.fingerprint,fingerprintKey(candidate.fingerprint)]));
 const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
 // Mutual nearest positions prevent file order from deciding between identical copies.
 let progress=true;
 while(progress){progress=false;for(const candidate of anonymous.filter(c=>c.item.id==null)){
  const choices=expected.filter(c=>!matched.some(item=>item.id===c.part.number)&&keys.get(c.fingerprint)===keys.get(candidate.fingerprint)).map(c=>({...c,distance:distance(c.fingerprint.position,candidate.fingerprint.position)})).sort((a,b)=>a.distance-b.distance);
  const best=choices[0];if(!best||(choices[1]&&Math.abs(choices[1].distance-best.distance)<1e-4))continue;
  const competitors=anonymous.filter(c=>c.item.id==null&&keys.get(c.fingerprint)===keys.get(best.fingerprint)).map(c=>({c,distance:distance(c.fingerprint.position,best.fingerprint.position)})).sort((a,b)=>a.distance-b.distance);
  if(competitors[0]?.c!==candidate||(competitors[1]&&Math.abs(competitors[1].distance-best.distance)<1e-4))continue;
  const from=best.fingerprint,to=candidate.fingerprint,angle=to.angle-from.angle,c=Math.cos(angle),s=Math.sin(angle),dx=to.offset.x-from.offset.x,dy=to.offset.y-from.offset.y;
  const x=to.position.x-c*from.position.x+s*from.position.y+Math.cos(to.angle)*dx-Math.sin(to.angle)*dy;
  const y=to.position.y-s*from.position.x-c*from.position.y+Math.sin(to.angle)*dx+Math.cos(to.angle)*dy;
  candidate.item.paths=transformPaths(stored.get(best.part.number)!.paths,`matrix(${c} ${s} ${-s} ${c} ${x} ${y})`);
  candidate.item.id=best.part.number;matched.push(candidate.item);progress=true;
 }}
 const unmatched=imported.filter(p=>p.id==null||!ids.has(p.id));
 const names=unmatched.map((p,i)=>p.id!=null?`Part ${p.id}`:`Shape ${i+1}`);
 for(const [name,id] of Object.entries(assignments)){
  const index=names.indexOf(name);if(index<0||!ids.has(id)||matched.some(p=>p.id===id))throw new Error("Assign each new or changed shape to a different missing part.");
  unmatched[index]!.id=id;matched.push(unmatched[index]!);
 }
 const missing=[...ids].filter(id=>!matched.some(p=>p.id===id));
 const remaining=unmatched.filter(p=>!matched.includes(p));
 const remainingNames=names.filter((_,i)=>remaining.includes(unmatched[i]!));
 if((remaining.length||missing.length)&&extras==="review")return {unmatched:remainingNames,...(missing.length?{missing}:{})};
 if(missing.length)throw new Error(`The file is missing ${countOf(missing.length,"requested part")}. Assign the new or changed shapes to missing parts before applying it.`);
 const next=structuredClone(sheets),target=next.find(s=>s.id===sheetId)!;
 const layerNames=[...new Set(design.paths.map(p=>p.layer))],lightburn=/\.lbrn2$/i.test(filename);
 const indices=lightburn?generateProject(design,original,profiles).layers:[];
 let extraNumber=Math.max(...sheets.flatMap(s=>s.parts.map(p=>p.number)))+1;
 target.parts=[...matched,...(extras==="keep"?remaining:[])].map(item=>{
  const paths=item.paths.map(p=>({...p,layer:lightburn?indices.find(l=>l.index===Number(p.layer))?.layer??p.layer:p.layer}));
  if(paths.some(p=>!layerNames.includes(p.layer)))throw new Error("An imported shape uses an unmapped layer. Assign an existing job layer before bringing it back.");
  const all=paths.flatMap(p=>p.points.flatMap(v=>[v,...(v.c0?[v.c0]:[]),...(v.c1?[v.c1]:[])])),b=outlineBounds(all),d=normalise(paths);
  const part:Placement={...b,number:item.id!=null&&ids.has(item.id)?item.id:extraNumber++,rotated:false,angle:0,translation:{x:b.x,y:b.y},footprint:b,design:d,locked:true,...(item.id==null||!ids.has(item.id)?{extra:true}:{})};
  part.footprint_outline=partOutline(design,part);return part;
 });
 validateAdjustedLayout(design,next,state,quantity);
 return {sheets:next,unmatched:remainingNames};
}
