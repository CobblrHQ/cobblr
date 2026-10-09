import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { machinesRouter } from "./machines.js";
import { registerMachinesResolvers } from "./resolvers.js";
import { registerMachinesActionHandlers } from "./action-handlers.js";
import { registerMachinesWriter } from "./sync-writer.js";

registerMachinesResolvers();
platform().devices.registerMachineRecords({
  get: async (orgId, kind, id, userId) => {
    if (await platform().entities.baseKindOf(orgId, kind) !== "machines:machine") return null;
    const record = await platform().entities.lookup(orgId, kind, id, { userId: userId ?? undefined });
    return record && !record.retired ? record : null;
  },
  list: async (orgId, userId) => {
    const records: Array<{ kind: string; record: import("@cobblr/platform-contract").ResolvedEntity }> = [];
    for (const instance of await platform().instances.list(orgId)) {
      if (instance.module_name !== "machines") continue;
      const kind = instance.is_default ? "machines:machine" : `${instance.instance_name}:item`;
      const page = await platform().entities.listAll(orgId, kind, {}, { userId: userId ?? undefined });
      if (!page.complete) throw new Error("Narrow the machine collection before preparing this job.");
      records.push(...page.items.filter(record => !record.retired).map(record => ({ kind, record })));
    }
    return records;
  },
});
registerMachinesActionHandlers();
registerMachinesWriter(); // opt in as a sync target (e.g. mirror an external system's printers)
// Declare machines:machine as a scan target. (Audit 2026-06-26 follow-up — was
// a hardcoded entry in core-scan's SCANNABLE/endpoint/qty maps; its noun was
// the wrong "part" fallback, now correctly "machine".)
platform().entities.registerScannable("machines:machine", {
  noun: "machine",
  createEndpoint: "machines/machines",
  qtyField: "quantity",
  // A record of five identical printers is five printers; its named units stay
  // under it in every list (units.ts), so a count can say both.
  qtyCountsThings: true,
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
