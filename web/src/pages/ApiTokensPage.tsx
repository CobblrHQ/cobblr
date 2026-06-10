// /configuration/tokens — long-lived FULL-ACCESS API tokens for CLI / AI /
// agent use. Thin wrapper over TokenManager (variant "personal"). The
// restricted, deny-by-default OPERATOR scopes (feedback triage, Discord
// ingest, announce, eval harnesses — all /super-admin/* surfaces) are
// deliberately NOT mintable here: that's the operator console's job
// (/admin/tokens). They used to be checkboxes on this page, which both
// buried operator tooling in workspace land and let a non-platform-admin
// mint a token that 403s everywhere.

import { usePageTitle } from "@cobblr/platform-web";
import { TokenManager } from "../components/TokenManager";

export function ApiTokensPage() {
  usePageTitle("API tokens");
  return <TokenManager variant="personal" />;
}
