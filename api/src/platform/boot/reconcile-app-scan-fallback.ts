// A managed app's own table is its scan fallback, for app workspaces that were
// provisioned before provisioning set it. Two cobblr_meta reads.
import { bootPass } from "../boot-passes.js";
import { reconcileAppScanFallback } from "../reconcile-app-scan-fallback.js";

export default bootPass({
  name: "reconcileAppScanFallback",
  phase: "workspaces",
  after: ["reconcileScanCategoryFields"],
  run: () => reconcileAppScanFallback(),
  report: (r) => (r.orgsHealed > 0 ? `app scan-fallback reconcile: ${r.orgsHealed} workspace(s) pointed at their app's table` : null),
});
