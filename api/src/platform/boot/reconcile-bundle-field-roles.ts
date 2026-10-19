// A field a bundle owns carries the role its current manifest declares, even
// on an install whose update is waiting on the prompt (a lot the scan reads
// is filed by role). Fills a missing role only; meta-only.
import { bootPass } from "../boot-passes.js";
import { reconcileBundleFieldRoles } from "../bundle-field-roles.js";

export default bootPass({
  name: "reconcileBundleFieldRoles",
  phase: "bundles",
  after: ["reconcileBundleApps"],
  run: () => reconcileBundleFieldRoles(),
  report: (r) => (r > 0 ? `bundle field roles: ${r} filled from the catalog` : null),
});
