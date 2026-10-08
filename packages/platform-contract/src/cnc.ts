import { z } from "zod";
const NumberValue = z.number().finite();
export const CncPointSchema = z.object({x:NumberValue,y:NumberValue,z:NumberValue});
export const CncMachineSchema = z.object({
 envelope:z.object({min:CncPointSchema,max:CncPointSchema}),safeZ:NumberValue.positive(),rapidFeed:NumberValue.positive(),reminders:z.array(z.string().trim().min(1).max(200)).max(20),
});
export const CncApprovalSchema = z.object({
 stockId:z.string().uuid(),stockRevision:z.number().int().nonnegative(),
 dimensions:z.object({width:NumberValue.positive(),height:NumberValue.positive(),thickness:NumberValue.positive()}),
 origin:z.object({x:NumberValue.nonnegative(),y:NumberValue.nonnegative()}),
 stockLoaded:z.boolean(),probedZ:z.boolean(),workOffset:z.boolean(),clampsClear:z.boolean(),
 reminders:z.array(z.string().max(200)).max(20),
 tools:z.array(z.object({number:z.number().int().min(1).max(9999),partId:z.string().uuid(),diameter:NumberValue.positive(),loaded:z.boolean()})).min(1).max(100),
});
export type CncApproval = z.infer<typeof CncApprovalSchema>;
export type CncMachine = z.infer<typeof CncMachineSchema>;
export interface CncProgramSummary {
 version:1; bounds:{min:z.infer<typeof CncPointSchema>;max:z.infer<typeof CncPointSchema>};
 tools:{number:number;diameter:number|null;description:string;estimatedSeconds:number}[];
 estimatedSeconds:number;
}
export interface CncStationStock {
 id:string;name:string;shape:"sheet"|"count"|"wearing_tool";revision:number;
 width?:number;height?:number;thickness?:number;diameter?:number;remaining?:number;
 freeRectangles?:{x:number;y:number;width:number;height:number}[];
}
export const CncRuntimeRecoverySchema=z.object({tools:z.array(z.object({number:z.number().int().min(1).max(9999),observedSeconds:NumberValue.nonnegative()})).min(1).max(100)});
export type CncRuntimeRecovery=z.infer<typeof CncRuntimeRecoverySchema>;
