// Who is looking at the scan inbox, as the row-state resolver wants it:
// the workspace's tables, whether this person may install one, and whether
// they may file into each (@cobblr/platform-contract/scan-triage,
// ScanRowStateContext).
//
// One answer for every surface. The card built its own (tables, the role,
// /me/capabilities) and the page's session strip built none, so a member's
// row said "Ask an admin" while the strip beside it said "Install & file 1"
// and File all met the refusal the row had already explained (#3122). The
// page and the card read this hook; a test reads `scanViewerContext`, the
// pure core the hook wraps, so it exercises the same door the page does.

import { useQuery } from "@tanstack/react-query";
import type { ScanRowStateContext } from "@cobblr/platform-contract/scan-triage";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { mayCreateIn } from "@cobblr/platform-contract/create-capability";
import { api, type ScanMenuEntry } from "../lib/api";
import { scanResolverTables } from "../lib/scanResolverTables";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export interface ScanViewerInput {
  /** The person's role in the workspace; unknown while the org loads. */
  role: string | null | undefined;
  /** What /me/capabilities said, or null while it loads (nothing blocks). */
  caps: { all: boolean; grants: readonly string[] } | null | undefined;
  /** The workspace's scan menu, or null while it loads. */
  menu: readonly ScanMenuEntry[] | null | undefined;
}

/** The resolver's context for this person over this workspace's tables. */
export function scanViewerContext({ role, caps, menu }: ScanViewerInput): ScanRowStateContext {
  return {
    // The workspace's tables as the contract reads them: the label of a
    // table a person chose (#3062) and, through the fit shape the menu
    // entries carry, the better-table question by the router's own rule
    // (#3136). One builder, so nothing hands the resolver a different menu.
    tables: scanResolverTables(menu),
    // Installing a bundle is the admin tier's, by rank (an editor is in it;
    // org-roles.ts). Unknown while the org loads is not "may not".
    ...(role ? { canInstall: roleSatisfies(role, ["owner", "admin"]) } : {}),
    // Filing is the server's own answer, read against the destination's
    // create gate (create-capability.ts). A member without the grant used to
    // see a green Add and learn otherwise from the 403 (#3072, #3073).
    permittedFor: (module) => mayCreateIn(module, caps ?? null),
  };
}

/** The context for the signed-in person over the active workspace. */
export function useScanViewer(menu: readonly ScanMenuEntry[] | null | undefined): ScanRowStateContext {
  const { activeSlug, activeOrg } = useActiveOrg();
  const myCaps = useQuery({
    queryKey: ["me-capabilities", activeSlug],
    queryFn: () => api.getMyCapabilities(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  return scanViewerContext({ role: activeOrg?.role, caps: myCaps.data ?? null, menu });
}
