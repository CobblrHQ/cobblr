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
import { mayCreateIn, mayRestockIn } from "@cobblr/platform-contract/create-capability";
import { api, type ScanMenuEntry } from "../lib/api";
import { scanResolverTables } from "../lib/scanResolverTables";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useCapabilitiesFor } from "../lib/can";

export interface ScanViewerInput {
  /** The person's role in the workspace; unknown while the org loads. */
  role: string | null | undefined;
  /** What /me/capabilities said, or null while it loads (nothing blocks). */
  caps: { all: boolean; grants: readonly string[] } | null | undefined;
  /** The workspace's scan menu, or null while it loads. */
  menu: readonly ScanMenuEntry[] | null | undefined;
  /** Every module this deployment has, with whether it is on here, or null
   *  while it loads (nothing blocks). */
  modules?: ReadonlyArray<{ name: string; enabled?: boolean }> | null;
  /** Every table in the workspace by its name, or null while it loads. */
  instances?: ReadonlyArray<{ instance_name: string; display_name?: string | null }> | null;
}

/** The resolver's context for this person over this workspace's tables. */
export function scanViewerContext({ role, caps, menu, modules, instances }: ScanViewerInput): ScanRowStateContext {
  return {
    // A re-buy's table may be one the menu does not offer; it is still named
    // as the workspace names it, never by its id (#6004).
    ...(instances ? { tableNames: instances } : {}),
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
    // Adding to stock already there is its own grant (#8850).
    mayRestock: (module) => mayRestockIn(module, caps ?? null),
    // A destination in an app that is off here is a table to turn on, asked
    // for, or unavailable; never a ready Add the server refuses (#3610).
    // An empty list is not an answer (a workspace always has its scan
    // module): read as "not known yet", which never blocks.
    ...(modules && modules.length > 0
      ? {
          moduleState: (module: string) => {
            const m = modules.find((x) => x.name === module);
            return !m ? "absent" : m.enabled ? "enabled" : "available";
          },
        }
      : {}),
  };
}

/** The context for the signed-in person over the active workspace. */
export function useScanViewer(menu: readonly ScanMenuEntry[] | null | undefined): ScanRowStateContext {
  const { activeSlug, activeOrg } = useActiveOrg();
  const myCaps = useCapabilitiesFor(activeSlug);
  // The same cached list the nav reads: no extra request.
  const orgModules = useQuery({
    queryKey: ["org-modules", activeSlug],
    queryFn: () => api.orgModules(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  // The same cached list every page that names a table reads.
  const instances = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  return scanViewerContext({ role: activeOrg?.role, caps: myCaps, menu, modules: orgModules.data?.items ?? null, instances: instances.data?.items ?? null });
}
