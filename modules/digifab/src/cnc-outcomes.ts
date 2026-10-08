import type { CncRuntimeRecovery } from "@cobblr/platform-contract/cnc";
import type { MachineDriver } from "./drivers/types.js";
import { confirmedCncRuntime, mergeCncRuntime, type CncUseSnapshot } from "./cnc-runtime.js";
export class CncOutcomeRefusal extends Error {
 constructor(readonly code:string,message:string,readonly details?:CncRuntimeRecovery){super(message);}
}
export async function finalCncRuntime(driver:Pick<MachineDriver,"getJobStatus"|"listDevices">,deviceId:string,remoteJobId:string|null,previous:Record<string,number>,tools:CncUseSnapshot["tools"],completed:boolean,confirmed?:Record<string,number>):Promise<Record<string,number>>{
 const native=remoteJobId?await driver.getJobStatus(remoteJobId).catch(()=>null):null;
 if(native&&!["completed","cancelled","failed"].includes(native.state))throw new CncOutcomeRefusal("machine_not_finished","Confirm Stop before recording this CNC outcome.");
 const device=(await driver.listDevices()).find(item=>item.id===deviceId);
 if(!device?.enabled||device.state?.toLowerCase()!=="idle")throw new CncOutcomeRefusal("machine_not_idle","The CNC controller must confirm idle before recording its stock and bit use.");
 if(native){
  const reported=native.raw&&typeof native.raw==="object"?(native.raw as Record<string,unknown>).toolSeconds:undefined;
  try{return mergeCncRuntime(previous,reported,tools);}catch(e){throw new CncOutcomeRefusal("invalid_runtime",e instanceof Error?e.message:"The CNC controller did not report valid bit runtime.");}
 }
 if(completed)return mergeCncRuntime({},previous,tools);
 const details={tools:tools.map(tool=>({number:tool.number,observedSeconds:previous[String(tool.number)]??0}))};
 if(confirmed){try{return confirmedCncRuntime(previous,confirmed,tools);}catch(e){throw new CncOutcomeRefusal("runtime_confirmation_required",e instanceof Error?e.message:"Enter actual bit runtime.",details);}}
 throw new CncOutcomeRefusal("runtime_confirmation_required","Enter actual bit runtime before recording this CNC outcome.",details);
}
