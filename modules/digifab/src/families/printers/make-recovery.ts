import { narrowSweep } from "@cobblr/platform-contract/sweep-candidates";
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { recoverPrintThis } from "./print-this.js";

export function registerMakeRecovery(): void {
  platform().sweeps.register(narrowSweep({
    name: "digifab.make-recovery", module: "digifab", everyMs: 60_000, firstAfterMs: 30_000,
    visit: async ({ orgId, db }) => recoverPrintThis(orgId, db as Kysely<DigifabDB>),
  }, hasMakeWork));
}

export async function hasMakeWork({ db }: { db: unknown }): Promise<boolean> {
  const tenant = db as Kysely<DigifabDB>;
  if (await tenant.selectFrom("digifab_make_steps").select("id").where("step", "=", "print")
    .where("status", "=", "running").limit(1).executeTakeFirst()) return true;
  for (const [stage, next] of [["design", "model"], ["slice", "print"]] as const) {
    if (await tenant.selectFrom("digifab_make_steps as pending").select("pending.id")
      .where("pending.step", "=", stage).where("pending.status", "in", ["running", "done"])
      .where(eb => eb.not(eb.exists(eb.selectFrom("digifab_make_steps as following").select("following.id")
        .whereRef("following.make_id", "=", "pending.make_id").where("following.step", "=", next))))
      .limit(1).executeTakeFirst()) return true;
  }
  return false;
}
