import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import type { Design, Sheet } from "./laser-layout.js";
import type { NestResult } from "./nesting-pool.js";
const require = createRequire(import.meta.url);
let solver: { nest(input: string): string } | undefined;
parentPort!.on("message", async (raw: string) => {
 try {
  type Polygon = { type: "simple_polygon"; data: [number,number][] };
  const input = JSON.parse(raw) as { seed: number; attempts: number; quantity: number; separation: number; item: {shape:Polygon}; containers: {shape:Polygon;zones:{quality:number;shape:Polygon}[]}[]; rectangle?: { design: Design; quantity: number; sheets: Sheet[]; spacing: number; kerf: number; rotate: boolean; partial?: boolean } };
  if (input.rectangle) {
   const entry = new URL("./laser-layout.js", import.meta.url);
   // imports: ./laser-layout.ts
   const { nestParts } = await import(existsSync(entry) ? entry.href : new URL("./laser-layout.ts", import.meta.url).href);
   const r = input.rectangle;
   parentPort!.postMessage({ result: nestParts(r.design,r.quantity,r.sheets,r.spacing,r.kerf,r.rotate,r.partial) });
  } else {
   solver ??= require("../nesting/pkg/cobblr_nesting.cjs");
   let best: NestResult | undefined, bestArea = Infinity;
   for(let attempt=0;attempt<input.attempts;attempt++) {
    const containers=input.containers.map(container=>{
     if(attempt%2===0)return container;
     const footprint=best?.outlines.find(parts=>parts.length)?.[0] ?? input.item.shape.data;
     const xs=footprint.map(p=>p[0]),ys=footprint.map(p=>p[1]);
     const rows=Math.ceil(Math.sqrt(input.quantity));
     const height=rows*Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))+input.separation*2;
     const left=Math.min(...container.shape.data.map(p=>p[0])),right=Math.max(...container.shape.data.map(p=>p[0]));
     const top=Math.max(...container.shape.data.map(p=>p[1])),y=Math.min(...container.shape.data.map(p=>p[1]))+height;
     if(y>=top)return container;
     // Temporary hazards explore a shorter occupied band without changing the physical sheet.
     const shape:Polygon={type:"simple_polygon",data:[[left,y],[right,y],[right,top],[left,top]]};
     return {...container,zones:[...container.zones,{quality:0,shape}]};
    });
    const result=JSON.parse(solver!.nest(JSON.stringify({...input,containers,compact:attempt%2===0,grid:attempt%2!==0,seed:(input.seed+attempt*104729)%Number.MAX_SAFE_INTEGER}))) as NestResult;
    const area=result.outlines.reduce((total,parts)=>{
     let left=Infinity,bottom=Infinity,right=-Infinity,top=-Infinity;
     for(const part of parts)for(const [x,y] of part) {left=Math.min(left,x);bottom=Math.min(bottom,y);right=Math.max(right,x);top=Math.max(top,y);}
     return total+(left===Infinity?0:(right-left)*(top-bottom));
    },0);
    if(!best || result.placed>best.placed || result.placed===best.placed && area<bestArea) {
     best=result;bestArea=area;parentPort!.postMessage({progress:best});
    }
   }
   parentPort!.postMessage({ result: best });
  }
 } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
