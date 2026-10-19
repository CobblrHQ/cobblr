// The web app's door to the one gate (packages/platform-web/src/can.ts,
// #7552): the active workspace, its role and the app's own api client, so a
// page asks what its viewer may do the same way a module page does, outside
// the platform provider too, and every page shares one cached answer.
import { myCapabilitiesKey, useCan as useCanIn, useCapabilities as useCapabilitiesIn, useRoleAtLeast as useRoleAtLeastIn, type MyCapabilities } from "@cobblr/platform-web";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "./api";

const ask = (slug: string) => api.getMyCapabilities(slug) as Promise<MyCapabilities>;

function useActiveSource() {
  const { activeSlug, activeOrg } = useActiveOrg();
  return { slug: activeSlug, ask, role: activeOrg?.role ?? null };
}

/** What the viewer may do in the active workspace, or null until known. */
export function useCapabilities(): MyCapabilities | null {
  return useCapabilitiesIn(useActiveSource());
}

/** The same, for a page that names its workspace itself (a portal page, the
 *  app player, a station): it needs no active-workspace context. */
export function useCapabilitiesFor(slug: string | null | undefined): MyCapabilities | null {
  return useCapabilitiesIn({ slug, ask });
}

/** May the viewer run `action`? null while the answer is on its way. */
export function useCan(action: string): boolean | null {
  return useCanIn(action, useActiveSource());
}

/** Does the viewer's role reach one of `roles` (a contract list the route reads too)? */
export function useRoleAtLeast(roles: readonly OrgRoleName[]): boolean {
  return useRoleAtLeastIn(roles, useActiveSource());
}

/** The gate's query, for a loader outside React that fills the same cache
 *  entry every page reads (waitingScans.ts). */
export function capabilitiesQuery(slug: string) {
  return { queryKey: myCapabilitiesKey(slug), queryFn: () => ask(slug), staleTime: 60_000 };
}
