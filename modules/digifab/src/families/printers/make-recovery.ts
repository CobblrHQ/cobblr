import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { recoverPrintThis } from "./print-this.js";

export function registerMakeRecovery(): void {
  platform().sweeps.register({
    name: "digifab.make-recovery", module: "digifab", everyMs: 60_000, firstAfterMs: 30_000,
    visit: async ({ orgId, db }) => recoverPrintThis(orgId, db as Kysely<DigifabDB>),
  });
}
