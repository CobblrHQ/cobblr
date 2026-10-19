import type { Kysely } from "kysely";
import type { CncUseSnapshot, CncStockUse, DigifabDB } from "../../db.js";
export type { CncUseSnapshot, CncStockUse };
export function mergeCncRuntime(previous:Record<string,number>, reported:unknown, tools:{number:number;partId:string}[]):Record<string,number> {
 if(!reported || typeof reported!=="object" || Array.isArray(reported)) throw new Error("The CNC controller did not report bit runtime.");
 const result={...previous};
 for(const [number,value] of Object.entries(reported)) {
  if(!/^[1-9][0-9]*$/.test(number)||!tools.some(tool=>String(tool.number)===number)) throw new Error("The CNC controller reported runtime for an unreviewed tool.");
  if(typeof value!=="number"||!Number.isFinite(value)||value<0) throw new Error("The CNC controller reported invalid bit runtime.");
  result[number]=Math.max(result[number]??0,value);
 }
 return result;
}

export function cncStockUses(snapshot:CncUseSnapshot, seconds:Record<string,number>, outcome:"good"|"scrapped"):CncStockUse[] {
 const stock={partId:snapshot.stockId,source:`cnc:${snapshot.executionId}:stock`,outcome};
 const uses:CncStockUse[]=[snapshot.shape==="sheet"?{...stock,shape:"sheet",region:snapshot.region}:{...stock,shape:"count",amount:1}];
 const actual=mergeCncRuntime({},seconds,snapshot.tools),hours=new Map<string,number>();
 for(const tool of snapshot.tools) hours.set(tool.partId,(hours.get(tool.partId)??0)+(actual[String(tool.number)]??0)/3600);
 for(const [partId,amount] of hours) if(amount>0) uses.push({partId,source:`cnc:${snapshot.executionId}:tool:${partId}`,shape:"wearing_tool",amount,outcome});
 return uses;
}

export async function persistCncRuntime(db:Kysely<DigifabDB>,jobId:string,reported:unknown):Promise<void> {
 await db.transaction().execute(async trx=>{
  const current=await trx.selectFrom("digifab_jobs").select(["cnc_setup","cnc_tool_seconds","cnc_usage_report"]).where("id","=",jobId).forUpdate().executeTakeFirst();
  if(!current?.cnc_setup||current.cnc_usage_report)return;
  const seconds=mergeCncRuntime(current.cnc_tool_seconds,reported,current.cnc_setup.tools);
  await trx.updateTable("digifab_jobs").set({cnc_tool_seconds:seconds}).where("id","=",jobId).execute();
 });
}

export function confirmedCncRuntime(previous:Record<string,number>,actual:Record<string,number>,tools:CncUseSnapshot["tools"]):Record<string,number>{
 for(const tool of tools){const seconds=actual[String(tool.number)];if(typeof seconds!=="number"||!Number.isFinite(seconds)||seconds<0||seconds<(previous[String(tool.number)]??0))throw new Error(`Enter actual seconds for tool ${tool.number}, at least the runtime already observed.`);}
 return mergeCncRuntime(previous,actual,tools);
}
