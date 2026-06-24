import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { machinesRouter } from "./machines.js";
import { registerMachinesResolvers } from "./resolvers.js";
import { registerMachinesActionHandlers } from "./action-handlers.js";
import { registerMachinesWriter } from "./sync-writer.js";

registerMachinesResolvers();
registerMachinesActionHandlers();
registerMachinesWriter(); // opt in as a sync target (e.g. mirror companion app printers)

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones.
platform().instances.registerItemCounter("machines", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from machines_machines where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });
router.use("/machines", machinesRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD.
export { machinesRouter as primaryRouter };
