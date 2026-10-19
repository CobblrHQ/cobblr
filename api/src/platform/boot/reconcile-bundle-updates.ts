// Installed bundles catch up to the catalog on their own (patch/minor, with
// the install route's own gates). Idempotent: a current workspace costs one
// row in a meta query and opens no tenant pool.
import { bootPass } from "../boot-passes.js";
import { reconcileBundleUpdates } from "../bundle-updates.js";

export default bootPass({
  name: "reconcileBundleUpdates",
  phase: "bundles",
  run: () => reconcileBundleUpdates(),
  report: (r) => (r.applied > 0 ? `bundle updates: ${r.applied} applied, ${r.skipped} left for the prompt` : null),
});
