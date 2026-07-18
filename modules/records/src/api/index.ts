import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { recordsRouter } from "./records.js";
import { registerRecordsResolvers } from "./resolvers.js";

registerRecordsResolvers();
// Declare records:record as a scan target. No qtyField — a record has no
// quantity; each row is one entry in the collection.
platform().entities.registerScannable("records:record", {
  noun: "record",
  createEndpoint: "records/records",
});
// Date custom-fields on records:record land on the workspace calendar via
// the generic kernel source — the substrate has no native dates, so every
// date here is a bundle/user field.
platform().calendar.registerDateFieldSource({
  kind: "records:record",
  table: "records_records",
  entityModule: "records",
  entityType: "record",
});

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones.
platform().instances.registerItemCounter("records", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from records_records where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });
router.use("/records", recordsRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD — the platform
// dispatches /orgs/:slug/instances/:name/items here with req.instance set.
export { recordsRouter as primaryRouter };
