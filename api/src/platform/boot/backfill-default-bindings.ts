// Top up default bindings for orgs created before the seed-on-signup path.
// Idempotent per (org, source_kind, action_id, trigger_event), so repeated
// boots are safe.
import { bootPass } from "../boot-passes.js";
import { backfillDefaultBindings } from "../seed-bindings.js";

export default bootPass({
  name: "backfillDefaultBindings",
  phase: "after-migrations",
  after: ["reconcileBundleFieldAggregates", "reconcileIntegrationNav"],
  run: () => backfillDefaultBindings(),
  report: (r) => `default bindings backfilled: ${r} added`,
});
