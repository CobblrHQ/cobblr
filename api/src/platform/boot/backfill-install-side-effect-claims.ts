// The modules an install switched on before installs claimed them (#3918),
// where the activity log can say so. One cobblr_meta query, no tenant pool.
import { bootPass } from "../boot-passes.js";
import { backfillInstallSideEffectClaims } from "../backfill-install-side-effect-claims.js";

export default bootPass({
  name: "backfillInstallSideEffectClaims",
  phase: "workspaces",
  run: () => backfillInstallSideEffectClaims(),
  report: (r) => (r > 0 ? `install side-effect claims backfilled: ${r}` : null),
});
