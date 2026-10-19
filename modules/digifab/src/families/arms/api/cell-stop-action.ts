// Stop a cell's job (digifab:cell-stop): the handler its manifest entry names. Wired in ../index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../../db.js";
import { ArmRefusal } from "../station.js";
import { stopCellJob } from "../cells/run.js";

const Args = z.object({ machine_id: z.string().uuid() });

export function registerCellStopAction(): void {
  platform().actions.registerHandler("digifab.cell-stop", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) return { ok: false, error: "Sign in to this workspace to stop a cell." };
    try {
      const args = Args.parse(ctx.args ?? {}), db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const sent = await stopCellJob(db, ctx.orgId, args.machine_id, { userId: ctx.userId, via: "assistant", admin: false });
      return { ...sent, summary: "Stopped the cell's job and its machines. Check the cell." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof ArmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
