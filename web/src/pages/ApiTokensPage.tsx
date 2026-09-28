// /configuration/tokens — personal API tokens for CLI / AI / agent use, each
// held to a workspace and an access level (look / change / full). Thin wrapper
// over TokenManager (variant "personal"); a new token starts on this page's
// workspace. The restricted, deny-by-default OPERATOR scopes (feedback triage,
// Discord ingest, announce, eval harnesses — all /super-admin/* surfaces) are
// deliberately NOT mintable here: that's the operator console's job
// (/admin/tokens).

import { usePageTitle } from "@cobblr/platform-web";
import { TokenManager } from "../components/TokenManager";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function ApiTokensPage() {
  usePageTitle("API tokens");
  const { activeOrg } = useActiveOrg();
  return <TokenManager variant="personal" activeOrgId={activeOrg?.id ?? null} />;
}
