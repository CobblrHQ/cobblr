import { z } from "zod";
export const BenchReportSchema=z.object({
 identity:z.string().min(1).max(512),profile:z.enum(["psu","dmm","rigol-ds1000z"]),at:z.string().datetime(),
 readings:z.array(z.object({quantity:z.enum(["voltage","current","resistance","frequency","period","capacitance"]),value:z.number().finite(),unit:z.enum(["V","A","ohm","Hz","s","F"])}).strict()).max(2),
 screenshot:z.object({mime_type:z.literal("image/bmp"),data_b64:z.string().min(1).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict().optional(),
}).strict().superRefine((report,ctx)=>{
 const units:Record<string,string>={voltage:"V",current:"A",resistance:"ohm",frequency:"Hz",period:"s",capacitance:"F"};
 if(report.readings.some(r=>units[r.quantity]!==r.unit)||report.readings.some(r=>Math.abs(r.value)>=9e37))ctx.addIssue({code:"custom",message:"The instrument's value or unit is invalid."});
 const age=Date.now()-Date.parse(report.at);if(age< -30000||age>60000)ctx.addIssue({code:"custom",message:"Read the instrument again to log a fresh reading."});
 if(report.profile==="psu"&&(report.readings.length!==2||report.readings[0]?.quantity!=="voltage"||report.readings[1]?.quantity!=="current")||report.profile==="dmm"&&report.readings.length!==1||report.profile==="rigol-ds1000z"&&(!report.screenshot||report.readings.length))ctx.addIssue({code:"custom",message:"The instrument returned an incomplete reading."});
});
export type BenchReport=z.infer<typeof BenchReportSchema>;
export const BenchRequest=z.object({machine_id:z.string().uuid(),operation:z.enum(["identify","read","log","output_off"]),record_kind:z.string().min(3).max(120).regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/).optional(),record_id:z.string().uuid().optional()}).strict();
export type BenchRequestInput=z.infer<typeof BenchRequest>;
