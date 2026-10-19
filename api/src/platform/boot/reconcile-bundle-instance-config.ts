// A table a bundle installed carries the declarations its current manifest
// makes (a Lego Sets table's parts_into), on an install from before them.
// Fills a missing key only; meta-only.
import { bootPass } from "../boot-passes.js";
import { reconcileBundleInstanceConfig } from "../bundle-instance-config.js";

export default bootPass({
  name: "reconcileBundleInstanceConfig",
  phase: "bundles",
  after: ["reconcileBundleFieldRoles"],
  run: () => reconcileBundleInstanceConfig(),
  report: (r) => (r > 0 ? `bundle tables: ${r} filled from the catalog` : null),
});
