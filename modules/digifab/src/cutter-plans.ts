// A saved cutter plan and its check at Start: the plan a job carries, the
// cutter it was made for, and the roll and geometry Start verifies. Making a
// plan and recording its use are the lasers family's (families/lasers/cutter-batch.ts).
import {isDeepStrictEqual} from "node:util";
import {createHash} from "node:crypto";
import {z} from "zod";
import {platform} from "@cobblr/platform-contract";
import type {Kysely} from "kysely";
import {validateCutterProgram,type CutterProgram,type CutterController} from "@cobblr/platform-contract/cutter-program";
import type {DigifabDB} from "./db.js";
import {currentCutterRoll,cutterRollMismatch,type CutterRoll} from "./cutter-stock.js";
import {buildDriverById} from "./jobs-core.js";
import {ReviewRequired} from "./drivers/job-review.js";
const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export const CutterMachine=z.object({connection_id:z.string().uuid(),device_id:z.string().min(1).max(200)});
export interface CutterPlan {program:CutterProgram;roll:CutterRoll;content_hash:string;source_hash:string;source_library_id:string;quantity:number;used_length_m:number}
export const CutterReportSchema=z.object({verdict:z.enum(["good","scrap"]),used_length_m:z.number().finite().nonnegative().max(1000),idle_confirmed:z.literal(true),blade_up_confirmed:z.literal(true)});
export type CutterReport=z.infer<typeof CutterReportSchema>;
export async function cutterMachine(db:Kysely<DigifabDB>,orgId:string,b:z.infer<typeof CutterMachine>) {
 const driver=await buildDriverById(db,orgId,b.connection_id);
 if(!driver?.prepareJob || await driver.jobReviewKind?.()!=="cutter" || !await driver.jobReviewRequired?.())throw new ReviewRequired("Choose a connected cutter with station review.");
 const device=(await driver.listDevices()).find(d=>d.id===b.device_id);
 if(!device || device.enabled === false || device.station_kind!=="cutter" || !device.raw?.cutterController)throw new ReviewRequired("Save this cutter's bridge configuration first.");
 const controller=device.raw.cutterController as CutterController;
 if(![controller.width_mm,controller.length_mm].every(n=>Number.isFinite(n)&&n>0))throw new ReviewRequired("Save this cutter's width and feed range first.");
 return {driver,device,controller};
}
export async function verifyCutterPlan(db:Kysely<DigifabDB>,orgId:string,jobId:string,connectionId:string,deviceId:string,loaded=false,allowStarted=false) {
 const saved=await db.selectFrom("digifab_cutter_plans").selectAll().where("job_id","=",jobId).where("connection_id","=",connectionId).where("remote_device_id","=",deviceId).executeTakeFirst();
 if(!saved || !allowStarted && saved.started_at || saved.consumed_at)throw new ReviewRequired("Use an unstarted cutter plan prepared for this job and machine.");
 const library=await db.selectFrom("digifab_library").selectAll().where("id","=",saved.library_id).executeTakeFirst(),job=await db.selectFrom("digifab_jobs").selectAll().where("id","=",jobId).executeTakeFirst();
 if(library?.kind!=="cutter-plan" || job?.file_id!==library.file_id)throw new ReviewRequired("The queued cutter file changed. Prepare a new plan.");
 const file=await platform().files.read(orgId,library.file_id);
 if(!file || hash(file.bytes)!==saved.plan.content_hash)throw new ReviewRequired("The queued cutter output changed. Prepare a new plan.");
 const program=validateCutterProgram(JSON.parse(Buffer.from(file.bytes).toString("utf8")));
 if(!isDeepStrictEqual(program,saved.plan.program))throw new ReviewRequired("The reviewed cutter geometry changed.");
 const roll=await currentCutterRoll(orgId,connectionId,deviceId,saved.plan.roll.id,loaded),reason=cutterRollMismatch(saved.plan.roll,roll,saved.plan.used_length_m);
 if(reason)throw new ReviewRequired(reason);
 const {controller}=await cutterMachine(db,orgId,{connection_id:connectionId,device_id:deviceId});
 if(program.width_mm>controller.width_mm||program.length_mm>controller.length_mm)throw new ReviewRequired("The cut no longer fits this cutter's configured range.");
 return saved;
}
