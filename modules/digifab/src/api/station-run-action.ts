// digifab:station-run (#6672): what an operator does at a machine's station
// once an admin prepared the job. Recording a cutter's or a large-format
// print's outcome, and starting, interrupting and recording an embroidery
// run. The setup halves stay in digifab:cutter-batch, digifab:large-format
// and digifab:embroidery-job, the admin tier's.
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { ReviewRequired } from "../drivers/job-review.js";
import { recordCutterOutcome } from "../cutter-actions.js";
import { recordLargePrintOutcome } from "../large-format/actions.js";
import { familyStationRun } from "../core/families.js";

export const STATION_RUN_OPERATIONS = ["cutter_outcome", "large_format_outcome", "embroidery_start", "embroidery_interrupt", "embroidery_outcome"] as const;

let registered = false;
export function registerStationRunAction(): void {
  if (registered) return;
  registered = true;
  platform().actions.registerHandler("digifab.station-run", async (ctx) => {
    if (!ctx.userId || !(await platform().auth.userMayRun({ orgId: ctx.orgId, userId: ctx.userId, actionId: "digifab:station-run" }))) return { ok: false, error: "An admin or an operator runs a job at its station." };
    const args = ctx.args ?? {};
    const fields = readJsonArg(args, "fields") ?? {};
    try {
      const operation = z.enum(STATION_RUN_OPERATIONS).parse(args.operation);
      const id = z.string().uuid().parse(args.id);
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
      if (operation === "cutter_outcome") return await recordCutterOutcome(db, ctx.orgId, id, ctx.userId, fields);
      if (operation === "large_format_outcome") return await recordLargePrintOutcome(db, ctx.orgId, id, ctx.userId, fields);
      const family = familyStationRun(operation);
      if (!family) return { ok: false, error: `No machine family answers ${operation} here.` };
      return await family.family.stationRun!.run(db, ctx.orgId, ctx.userId, family.operation, id, fields);
    } catch (error) {
      if (error instanceof ReviewRequired || error instanceof z.ZodError) return { ok: false, error: error.message };
      throw error;
    }
  });
}
