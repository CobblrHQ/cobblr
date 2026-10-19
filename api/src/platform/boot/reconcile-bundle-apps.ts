import { bootPass } from "../boot-passes.js";
import { reconcileBundleApps } from "../reconcile-bundle-apps.js";

export default bootPass({
  name: "reconcileBundleApps",
  phase: "bundles",
  after: ["reconcileBundleUpdates"],
  run: () => reconcileBundleApps(),
  report: (r) => (r.updated > 0 ? `bundle apps: ${r.updated} updated` : null),
});
