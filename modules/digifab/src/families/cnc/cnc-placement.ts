import type { CncProgramSummary,CncStationStock } from "@cobblr/platform-contract/cnc";
import { nestParts } from "../../laser-layout.js";
export function cncPlacement(program:Pick<CncProgramSummary,"bounds">,stock:CncStationStock,diameters:number[]) {
 if(stock.shape!=="sheet"||!stock.width||!stock.height||!stock.freeRectangles)throw new Error("Choose a sheet with saved remaining area.");
 if(!diameters.length||diameters.some(v=>!Number.isFinite(v)||v<=0))throw new Error("Choose every bit's diameter before placing this program.");
 const radius=Math.max(...diameters)/2,b=program.bounds;
 const free=stock.freeRectangles.map(r=>{const x=Math.max(r.x,b.min.x-radius),y=Math.max(r.y,b.min.y-radius);return {x,y,width:r.x+r.width-x,height:r.y+r.height-y};}).filter(r=>r.width>0&&r.height>0);
 const [sheet]=nestParts({width:b.max.x-b.min.x+2*radius,height:b.max.y-b.min.y+2*radius},1,[{id:stock.id,width:stock.width,height:stock.height,revision:stock.revision,free_rectangles:free}],0,0,false);
 const part=sheet!.parts[0]!;
 return {origin:{x:part.x+radius-b.min.x,y:part.y+radius-b.min.y},region:part.footprint};
}
