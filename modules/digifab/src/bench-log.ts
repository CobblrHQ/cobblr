import { BenchReportSchema, type BenchReport } from "./bench-model.js";
export interface BenchLogInput {connection_id:string;device_id:string;record_kind:string;record_id:string}
export interface LoggedBenchReading extends BenchLogInput {id:string;report:BenchReport}
interface LogPorts {
 lookup:(kind:string,id:string)=>Promise<unknown|null>;
 read:()=>Promise<unknown>;
 save:(value:BenchLogInput & {report:BenchReport})=>Promise<LoggedBenchReading>;
 link:(id:string,kind:string,recordId:string)=>Promise<void>;
}
export async function logBenchReading(ports:LogPorts,input:BenchLogInput):Promise<LoggedBenchReading>{
 if(!await ports.lookup(input.record_kind,input.record_id))throw new Error("Choose a record in this workspace to keep the reading.");
 const report=BenchReportSchema.parse(await ports.read());
 const saved=await ports.save({...input,report});
 await ports.link(saved.id,input.record_kind,input.record_id);
 return saved;
}
