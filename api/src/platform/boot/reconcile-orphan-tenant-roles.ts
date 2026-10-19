// Sweep per-tenant Postgres roles left behind by deleted workspaces (roles are
// cluster-global, so DROP DATABASE never removed them). One query on a
// healthy instance; opens no tenant pools.
import { bootPass } from "../boot-passes.js";
import { reconcileOrphanTenantRoles } from "../reconcile-tenant-roles.js";

export default bootPass({
  name: "reconcileOrphanTenantRoles",
  phase: "workspaces",
  after: ["retireReceiptFailurePlaceholders"],
  run: () => reconcileOrphanTenantRoles(),
  report: (r) => (r.dropped > 0 || r.skippedBroken > 0 ? `orphaned tenant roles: ${r.dropped} dropped, ${r.skippedBroken} left for investigation` : null),
});
