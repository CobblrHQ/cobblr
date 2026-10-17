// Keep a robot arm's records (digifab:arm-record): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../../db.js";
import { ArmRefusal } from "../station.js";
import { addTypedProgram, editProgram, refreshArm, saveCompatibility, setMaintenance, setupArm } from "../store.js";

export function registerArmRecordAction(): void {
  platform().actions.registerHandler("digifab.arm-record", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Keeping a robot arm's records needs an owner or admin." };
    try {
      const args = ctx.args ?? {}, fields = readJsonArg(args, "fields") ?? {}, db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const id = z.string().uuid().parse(args.id);
      if (args.operation === "setup") return { ...await setupArm(db, ctx.orgId, ctx.userId, id, fields), summary: "Set up as a robot arm." };
      if (args.operation === "refresh") return { ok: true, ...await refreshArm(db, ctx.orgId, ctx.userId, id), summary: "Read the arm's controller." };
      if (args.operation === "add_program") return { ok: true, program: await addTypedProgram(db, ctx.orgId, ctx.userId, id, fields), summary: "Added the program." };
      if (args.operation === "edit_program") return { ok: true, program: await editProgram(db, ctx.orgId, ctx.userId, id, fields), summary: "Updated the program." };
      if (args.operation === "compatibility") return { ...await saveCompatibility(db, ctx.orgId, ctx.userId, id, fields), summary: "Recorded what works on this arm." };
      if (args.operation === "maintenance") return { ...await setMaintenance(db, ctx.orgId, ctx.userId, id, fields), summary: "Changed the arm's service state." };
      return { ok: false, error: "Choose setup, refresh, add_program, edit_program, compatibility or maintenance. Running the arm is at its station." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof ArmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
