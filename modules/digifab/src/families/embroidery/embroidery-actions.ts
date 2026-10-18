import { z } from "zod";
import type { Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../db.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import {
  saveEmbroideryMachine,
  importEmbroidery,
  prepareEmbroidery,
  startEmbroidery,
  interruptEmbroidery,
  recordEmbroideryUse,
} from "./embroidery-runs.js";
export async function embroideryMutation(
  db: Kysely<DigifabDB>,
  orgId: string,
  userId: string,
  operation: unknown,
  id: unknown,
  fields: unknown,
) {
  if (operation === "create_machine")
    return saveEmbroideryMachine(db, orgId, fields);
  if (operation === "import_design") return importEmbroidery(db, orgId, fields);
  if (operation === "prepare") return prepareEmbroidery(db, orgId, fields);
  const key = z.string().uuid().parse(id);
  if (operation === "update_machine")
    return saveEmbroideryMachine(db, orgId, fields, key);
  if (operation === "start") return startEmbroidery(db, orgId, key, fields);
  if (operation === "interrupt") return interruptEmbroidery(db, key);
  if (operation === "outcome")
    return recordEmbroideryUse(db, orgId, key, userId, fields);
  throw new ReviewRequired("Choose a supported embroidery operation.");
}
let registered = false;
export function registerEmbroideryActions() {
  if (registered) return;
  registered = true;
  platform().actions.registerHandler("digifab.embroidery-job", async (ctx) => {
    if (
      !ctx.userId ||
      !(await platform().auth.userHasRole({
        orgId: ctx.orgId,
        userId: ctx.userId,
        minRole: "admin",
      }))
    )
      return {
        ok: false,
        error: "An admin prepares and records embroidery runs.",
      };
    try {
      const args = ctx.args ?? {},
        db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
      return {
        ok: true,
        ...(await embroideryMutation(
          db,
          ctx.orgId,
          ctx.userId,
          args.operation,
          args.id,
          readJsonArg(args, "fields") ?? {},
        )),
      };
    } catch (error) {
      if (error instanceof ReviewRequired || error instanceof z.ZodError)
        return { ok: false, error: error.message };
      throw error;
    }
  });
}
