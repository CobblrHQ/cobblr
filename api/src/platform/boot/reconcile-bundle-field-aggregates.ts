// A shipped bundle's number fields add up the way its manifest now says
// (reconcile-bundle-field-aggregates.ts).
import { bootPass } from "../boot-passes.js";
import { reconcileBundleFieldAggregates } from "../reconcile-bundle-field-aggregates.js";

export default bootPass({
  name: "reconcileBundleFieldAggregates",
  phase: "after-migrations",
  after: ["reconcileContributedFields"],
  run: () => reconcileBundleFieldAggregates(),
});
