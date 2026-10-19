// Keep a cell's records (digifab:cell-record): the handler its manifest entry names. Wired in ../index.ts.
import type { Kysely } from "kysely";
import { z } from "zod";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../../db.js";
import { ArmRefusal } from "../station.js";
import { saveDefinition, setOperators, setOutput, setupCell } from "../cells/store.js";

export function registerCellRecordAction(): void {
  platform().actions.registerHandler("digifab.cell-record", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Keeping a cell's records needs an owner or admin." };
    try {
      const args = ctx.args ?? {}, fields = readJsonArg(args, "fields") ?? {}, db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
      const id = z.string().uuid().parse(args.id);
      if (args.operation === "setup") return { ...await setupCell(db, ctx.orgId, ctx.userId, id, fields), summary: "Set up as a cell." };
      if (args.operation === "definition") return { ...await saveDefinition(db, ctx.orgId, ctx.userId, id, fields), summary: "Saved the cell's job." };
      if (args.operation === "operators") return { ...await setOperators(db, ctx.orgId, ctx.userId, id, fields), summary: "Saved who runs the cell." };
      if (args.operation === "output") return { ...await setOutput(db, ctx.orgId, ctx.userId, id, fields), summary: "Saved where the cell's parts go." };
      return { ok: false, error: "Choose setup, definition, operators or output. Starting the cell is at its station." };
    } catch (e) { if (e instanceof z.ZodError || e instanceof ArmRefusal) return { ok: false, error: e.message }; throw e; }
  });
}
