// Default-exported Router. The platform mounts this at
// /api/v1/orgs/:slug/modules/inventory/ with requireAuth +
// withTenant pre-applied, so handlers can rely on req.session +
// req.tenant being populated.
//
// Side effects on import:
//   - Inventory's entity-kind resolvers register with the platform
//     so platform.entities.lookup("inventory:part", id) works.

import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { categoriesRouter } from "./categories.js";
import { partsRouter } from "./parts.js";
import { allocationsRouter } from "./allocations.js";
import { importRouter } from "./import.js";
import { spoolmanRouter } from "./spoolman.js";
import { registerInventoryResolvers } from "./resolvers.js";
import { registerInventoryActionHandlers } from "./action-handlers.js";
import { registerInventoryComputedContext } from "./computed-context.js";
import { registerInventoryWriter } from "./sync-writer.js";
import { registerReplaceClock } from "./replace-clock.js";

registerInventoryResolvers();
registerInventoryActionHandlers();
registerInventoryComputedContext();
registerInventoryWriter(); // silent cross-module writer (core-mobility et al.)
registerReplaceClock(); // time-based replace-clock (furnace filter → replace-due)
// Declare inventory:part as a scan target so core-scan routes a scanned item
// here without hardcoding the endpoint/qty/noun. (Audit 2026-06-26 follow-up.)
platform().entities.registerScannable("inventory:part", {
  noun: "part",
  createEndpoint: "inventory/parts",
  qtyField: "qty",
  default: true, // the fallback scan target when no identify hint matches a noun
});
// Any type='date' custom field on inventory:part (or its instances) becomes an
// all-day calendar event — the owning module declares its kind+table; the
// kernel runs the generic field-def query. (Audit 2026-06-26 follow-up.)
platform().calendar.registerDateFieldSource({
  kind: "inventory:part",
  table: "inventory_parts",
  entityModule: "inventory",
  entityType: "part",
});

// Per-instance item count — lets the nav hide an empty auto-created default
// instance once the workspace has named ones (parts are the primary entity).
platform().instances.registerItemCounter("inventory", async (orgId, instance) => {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
  const r = await sql<{ c: number }>`select count(*)::int as c from inventory_parts where instance = ${instance}`.execute(db);
  return r.rows[0]?.c ?? 0;
});

const router = Router({ mergeParams: true });

router.use("/categories", categoriesRouter);
router.use("/parts", partsRouter);
router.use("/allocations", allocationsRouter);
router.use("/spoolman", spoolmanRouter);
router.use(importRouter);

export default router;

// Primary-entity router for instance-scoped item CRUD. The platform
// mounts this at /orgs/:slug/instances/:name/items and dispatches with
// req.instance set; partsRouter reads instanceOf(req) on every query.
export { partsRouter as primaryRouter };
