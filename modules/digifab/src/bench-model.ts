import { z } from "zod";
export const BenchReportSchema=z.object({
 identity:z.string().min(1).max(512),profile:z.enum(["psu","dmm","rigol-ds1000z","riden","sigrok"]),at:z.string().datetime(),
 readings:z.array(z.object({quantity:z.enum(["voltage","current","resistance","frequency","period","capacitance","power","voltage_setpoint","current_limit","input_voltage","temperature"]),value:z.number().finite(),unit:z.enum(["V","A","ohm","Hz","s","F","W","C"])}).strict()).max(7),
 protection:z.enum(["none","OVP","OCP"]).optional(),output_enabled:z.boolean().optional(),
 capture:z.object({data_b64:z.string().min(1).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),decoded:z.string().max(200000)}).strict().optional(),
 screenshot:z.object({mime_type:z.literal("image/bmp"),data_b64:z.string().min(1).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict().optional(),
}).strict().superRefine((report,ctx)=>{
 const units:Record<string,string>={voltage:"V",current:"A",resistance:"ohm",frequency:"Hz",period:"s",capacitance:"F",power:"W",voltage_setpoint:"V",current_limit:"A",input_voltage:"V",temperature:"C"};
 if(report.readings.some(r=>units[r.quantity]!==r.unit)||report.readings.some(r=>Math.abs(r.value)>=9e37))ctx.addIssue({code:"custom",message:"The instrument's value or unit is invalid."});
 if(report.profile==="riden"&&(report.readings.length!==7||["voltage","current","power","voltage_setpoint","current_limit","input_voltage","temperature"].some(q=>!report.readings.some(r=>r.quantity===q))||report.protection===undefined||report.output_enabled===undefined))ctx.addIssue({code:"custom",message:"The supply returned an incomplete reading."});
 if(report.profile==="sigrok"&&(!report.capture||report.readings.length))ctx.addIssue({code:"custom",message:"The analyser returned no capture."});
 const age=Date.now()-Date.parse(report.at);if(age< -30000||age>60000)ctx.addIssue({code:"custom",message:"Read the instrument again to log a fresh reading."});
 if(report.profile==="psu"&&(report.readings.length!==2||report.readings[0]?.quantity!=="voltage"||report.readings[1]?.quantity!=="current")||report.profile==="dmm"&&report.readings.length!==1||report.profile==="rigol-ds1000z"&&(!report.screenshot||report.readings.length))ctx.addIssue({code:"custom",message:"The instrument returned an incomplete reading."});
});
export type BenchReport=z.infer<typeof BenchReportSchema>;
export const CaptureRequest=z.object({channels:z.array(z.string().regex(/^D\d{1,2}$/)).min(1).max(32),samplerate:z.number().int().min(1000).max(1000000000),duration_ms:z.number().int().min(1).max(10000),trigger:z.string().max(100).regex(/^(?:D\d{1,2}=[01rfec](?:,D\d{1,2}=[01rfec])*)?$/).optional(),decoder:z.enum(["uart","i2c","spi","can","onewire_link"]).optional(),decoder_options:z.record(z.string().max(80).regex(/^[a-zA-Z0-9_.-]+$/)).optional(),data_b64:z.string().min(1).max(2800000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional()}).strict();
export type CaptureInput=z.infer<typeof CaptureRequest>;
export const BenchRequest=z.object({machine_id:z.string().uuid(),operation:z.enum(["identify","read","log","output_off","capture","configure","output_on","set_voltage","set_current"]),record_kind:z.string().min(3).max(120).regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/).optional(),record_id:z.string().uuid().optional(),capture:CaptureRequest.optional(),control_enabled:z.boolean().optional(),confirmed:z.boolean().optional(),value:z.number().finite().nonnegative().optional()}).strict().superRefine((input,ctx)=>{
 if(["output_on","set_voltage","set_current"].includes(input.operation)&&input.confirmed!==true)ctx.addIssue({code:"custom",message:"Confirm each change to the supply."});
 if(["set_voltage","set_current"].includes(input.operation)&&input.value===undefined)ctx.addIssue({code:"custom",message:"Choose a set point."});
 if(input.operation==="configure"&&input.control_enabled===undefined)ctx.addIssue({code:"custom",message:"Choose whether instrument control is enabled."});
 if(input.operation==="capture"&&!input.capture)ctx.addIssue({code:"custom",message:"Choose capture settings."});
});
export type BenchRequestInput=z.infer<typeof BenchRequest>;
