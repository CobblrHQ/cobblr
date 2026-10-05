import type { Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import { z } from "zod";
import type { DigifabDB } from "./db.js";
import { acceptLaserPlan, LaserPlanRefusal } from "./laser-plans.js";
import { ProfileSchema } from "./laser-layout.js";
import { Machine, Plan, NewProfile, createLaserProfile, createLaserPlan, discardLaserPlan, importLaserProfiles, updateLaserProfile } from "./api/laser-writes.js";
let registered = false;
export function registerLaserActions(): void {
 if (registered) return;
 registered = true;
 platform().actions.registerHandler("digifab.laser-batch", async ctx => {
  if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Preparing a laser batch requires an admin." };
  try {
   const args = ctx.args ?? {}, fields = readJsonArg(args, "fields") ?? {};
   const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
   if (args.operation === "create_profile") return { ok: true, ...await createLaserProfile(db, ctx.orgId, NewProfile.parse(fields)) };
   if (args.operation === "import_profiles") return { ok: true, ...await importLaserProfiles(db, ctx.orgId, Machine.parse(fields)) };
   if (args.operation === "plan") return { ok: true, ...await createLaserPlan(db, ctx.orgId, Plan.parse(fields)) };
   const id = z.string().uuid().parse(args.id);
   if (args.operation === "update_profile") return { ok: true, ...await updateLaserProfile(db, id, ProfileSchema.parse(fields)) };
   if (args.operation === "queue") return { ok: true, ...await acceptLaserPlan(db, ctx.orgId, id) };
   if (args.operation === "discard") return await discardLaserPlan(db, id);
   return { ok: false, error: "Choose create_profile, import_profiles, update_profile, plan, queue or discard." };
  } catch (e) {
   if (e instanceof LaserPlanRefusal || e instanceof z.ZodError) return { ok: false, error: e.message };
   throw e;
  }
 });
}
