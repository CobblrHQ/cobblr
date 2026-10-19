// Self-heal the bundle-resource-claims ledger for installs that predate it, so
// a bundle uninstall can refcount correctly. Once per org, idempotent.
import { bootPass } from "../boot-passes.js";
import { backfillBundleClaims } from "../backfill-bundle-claims.js";

export default bootPass({
  name: "backfillBundleClaims",
  phase: "workspaces",
  after: ["reconcileAppScanFallback"],
  run: () => backfillBundleClaims(),
  report: (r) => (r > 0 ? `bundle-resource claims backfilled for ${r} org(s)` : null),
});
