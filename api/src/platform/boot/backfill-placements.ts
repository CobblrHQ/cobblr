// Seed the placement primitive from existing location_id values (a Location is
// one KIND of container). Runs after locations are canonical and before
// syncTenantMigrations. Idempotent; the dual-write keeps it fresh once it ships.
import { bootPass } from "../boot-passes.js";
import { backfillPlacements } from "../migrate-location-to-placement.js";

export default bootPass({
  name: "backfillPlacements",
  phase: "before-migrations",
  run: () => backfillPlacements(),
  report: (r) => (r.orgsTouched > 0 ? `location_id → placement backfill: ${r.orgsTouched} org(s), ${r.rowsInserted} placement row(s) seeded` : null),
});
