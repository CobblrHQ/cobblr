import { z } from "zod";
const common={name:z.string().min(1).max(120).optional(),control_enabled:z.boolean().optional()};
export const RidenConfig=z.object({...common,transport:z.enum(["tcp","rtu"]),host:z.string().max(253).optional(),port:z.coerce.number().int().min(1).max(65535).optional(),path:z.string().max(500).optional(),baud:z.coerce.number().int().min(1200).max(115200).optional(),unit:z.coerce.number().int().min(1).max(247).optional(),python:z.string().max(500).optional()}).strict();
export const ESPHomeBenchConfig=z.object({...common,host:z.string().min(1).max(253),port:z.coerce.number().int().min(1).max(65535).optional(),encryption_key:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),max_current:z.coerce.number().positive().max(18).optional()}).strict();
export const SigrokConfig=z.object({name:common.name,device:z.string().min(1).max(120),executable:z.string().max(500).optional()}).strict();
const schemas:Record<string,z.ZodTypeAny>={riden:RidenConfig,"esphome-bench":ESPHomeBenchConfig,sigrok:SigrokConfig};
export const BenchConnectionConfig=z.record(z.unknown()).superRefine((edge,ctx)=>{
 const schema=schemas[String(edge.driver)];if(!schema)return;
 const {driver:_driver,bridge:_bridge,config,...flat}=edge;
 if(config&&Object.keys(flat).length)ctx.addIssue({code:"custom",message:"Keep device fields inside config when using a nested driver configuration."});
 const result=schema.safeParse(config || flat);
 if(!result.success)for(const issue of result.error.issues)ctx.addIssue({...issue,path:[...(config?["config"]:[]),...issue.path]});
});
