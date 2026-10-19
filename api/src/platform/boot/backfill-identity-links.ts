// Central identity federation: link any unlinked local user to its global
// identity by email. No-op unless IDENTITY_URL is wired. Meta-only,
// idempotent, resilient: a failed batch never blocks boot.
import { bootPass } from "../boot-passes.js";
import { backfillIdentityLinks } from "../backfill-identity.js";

export default bootPass({
  name: "backfillIdentityLinks",
  phase: "workspaces",
  after: ["backfillInstallSideEffectClaims"],
  run: () => backfillIdentityLinks(),
  report: (r) => (r.linked > 0 ? `central identity: linked ${r.linked} local user(s)` : null),
});
