// Acknowledge a machine alarm (digifab:alarm-ack): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { acknowledgeAlarm, AlarmRefusal } from "../core/alarms.js";

export function registerAlarmAckAction(): void {
  platform().actions.registerHandler("digifab.alarm-ack", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) return { ok: false, error: "Sign in to this workspace to acknowledge an alarm." };
    try {
      const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const row = await acknowledgeAlarm(db, ctx.orgId, ctx.userId, ctx.args ?? {});
      return { ok: true, alarm: row, summary: `Acknowledged ${row.code}. No one further is told.` };
    } catch (e) { if (e instanceof z.ZodError || e instanceof AlarmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
