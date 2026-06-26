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
// Declare machines:machine as a scan target. (Audit 2026-06-26 follow-up — was
// a hardcoded entry in core-scan's SCANNABLE/endpoint/qty maps; its noun was
// the wrong "part" fallback, now correctly "machine".)
platform().entities.registerScannable("machines:machine", {
  noun: "machine",
  createEndpoint: "machines/machines",
  qtyField: "quantity",
});

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
