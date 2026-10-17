// Pause or stop a robot arm (digifab:arm-stop): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../../db.js";
import { ArmRefusal } from "../station.js";
import { sendArmCommand } from "../control.js";

const Args = z.object({ machine_id: z.string().uuid(), operation: z.enum(["pause", "stop"]) });

export function registerArmStopAction(): void {
  platform().actions.registerHandler("digifab.arm-stop", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) return { ok: false, error: "Sign in to this workspace to pause or stop an arm." };
    try {
      const args = Args.parse(ctx.args ?? {}), db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const sent = await sendArmCommand(db, ctx.orgId, args.machine_id, { command: { operation: args.operation } }, { userId: ctx.userId, via: "assistant", operate: false, admin: false });
      return { ...sent, summary: args.operation === "stop" ? "Sent Stop to the arm. Check the cell." : "Sent Pause to the arm." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof ArmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
