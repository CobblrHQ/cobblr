import type { CncApproval, CncStationStock } from "@cobblr/platform-contract/cnc";
import { validateCncPreflight, type CncProgram, type CncMachine } from "./cnc-program.js";

export function cncStockSelection(program:CncProgram, machine:CncMachine, stock:CncStationStock, library:CncStationStock[], approval:CncApproval) {
 if(stock.id!==approval.stockId || !["sheet","count"].includes(stock.shape)) throw new Error("Choose the loaded CNC sheet or block.");
 if(stock.remaining!==undefined&&(stock.shape==="count"?stock.remaining<1:stock.remaining<=0)) throw new Error("This stock cannot supply a whole block or usable sheet region. Choose another blank.");
 if(!approval.dimensions||approval.dimensions.width!==stock.width||approval.dimensions.height!==stock.height||approval.dimensions.thickness!==stock.thickness) throw new Error("The stock dimensions changed. Confirm the loaded stock again.");
 if(stock.revision!==approval.stockRevision) throw new Error("The loaded stock changed. Review its remaining area again.");
 if(!Number.isFinite(approval.origin.x)||!Number.isFinite(approval.origin.y)||approval.origin.x<0||approval.origin.y<0) throw new Error("Choose the work origin on the loaded stock.");
 const tools=program.tools.map(tool=>{
  const selected=approval.tools.filter(t=>t.number===tool.number);
  const bit=selected.length===1?library.find(item=>item.id===selected[0]!.partId && item.shape==="wearing_tool"):undefined;
  if(!bit || bit.remaining!==undefined&&bit.remaining<=0 || !selected[0]!.loaded) throw new Error(`Load tool ${tool.number}: ${tool.description}. Choose an available bit from the tool library.`);
  if(selected[0]!.diameter!==bit.diameter) throw new Error("The tool diameter changed. Confirm that bit and re-probe Z before Start.");
  return {number:tool.number,partId:bit.id,diameter:bit.diameter??NaN,loaded:true};
 });
 if(approval.tools.length!==tools.length) throw new Error("Match each posted tool once in the tool library.");
 const shift=(point:{x:number;y:number;z:number})=>({...point,x:point.x+approval.origin.x,y:point.y+approval.origin.y});
 const translated={...program,bounds:{min:shift(program.bounds.min),max:shift(program.bounds.max)}};
 const envelope={min:shift(machine.envelope.min),max:shift(machine.envelope.max)};
 validateCncPreflight(translated,{...machine,envelope},{width:stock.width??NaN,height:stock.height??NaN,thickness:stock.thickness??NaN},{...approval,tools});
 const radius=Math.max(...tools.map(tool=>tool.diameter))/2;
 const x=Math.max(0,translated.bounds.min.x-radius),y=Math.max(0,translated.bounds.min.y-radius);
 const region={x,y,width:Math.min(stock.width!,translated.bounds.max.x+radius)-x,height:Math.min(stock.height!,translated.bounds.max.y+radius)-y};
 if(stock.shape==="sheet" && (region.width<=0||region.height<=0||!stock.freeRectangles?.some(free=>region.x>=free.x-1e-6&&region.y>=free.y-1e-6&&region.x+region.width<=free.x+free.width+1e-6&&region.y+region.height<=free.y+free.height+1e-6))) throw new Error("The program does not fit this sheet's free area. Choose a usable region or a whole block.");
 return {region,tools:tools.map(({number,partId})=>({number,partId}))};
}
