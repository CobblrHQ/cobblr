// Set who is told about alarms (digifab:alarm-escalation): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { AlarmRefusal, setEscalation } from "../core/alarms.js";

export function registerAlarmEscalationAction(): void {
  platform().actions.registerHandler("digifab.alarm-escalation", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Choosing who is told about alarms needs an owner or admin." };
    try {
      const args = ctx.args ?? {};
      const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      await setEscalation(db, ctx.orgId, ctx.userId, { operators: readJsonArg(args, "operators") ?? [], supervisors: readJsonArg(args, "supervisors") ?? [], integrators: readJsonArg(args, "integrators") ?? [], supervisor_after_minutes: Number(args.supervisor_after_minutes), integrator_after_minutes: Number(args.integrator_after_minutes) });
      return { ok: true, summary: "Saved who is told about alarms." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof AlarmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
