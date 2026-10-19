// A view a bundle seeded names fields its kind has, as the shipped bundle now
// defines it, unless the person edited it (Lego 0.6.4's grouping).
import { bootPass } from "../boot-passes.js";
import { healBundleViewFields } from "../heal-bundle-view-fields.js";

export default bootPass({
  name: "healBundleViewFields",
  phase: "bundles",
  after: ["reconcileBundleInstanceConfig"],
  run: () => healBundleViewFields(),
  report: (r) => (r.healed > 0 ? `bundle views: ${r.healed} healed from the catalog` : null),
});
