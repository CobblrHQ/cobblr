// What the person viewing may do: the one gate every control asks before it
// is drawn (#7552).
//
// A page offered controls its viewer's role could not use, and probed
// permissions it would be refused: a member saw a calendar feed's Rotate that
// always answered 403 (#7507), was offered control of an arm at its station
// (#7522), was asked to confirm a list deletion it could not perform (#7524),
// and embroidery pages asked for station lists and permissions their viewer
// was refused (#7509, #7510). Each page had answered the question its own way,
// or not at all. Now a control asks here, by the action it performs:
//
//   const canRotate = useCan("calendar:rotate-feed");   // null until known
//   {canRotate && <button …>Rotate</button>}
//
// or, for a route that gates on a role list the contract names,
//
//   const canManage = useRoleAtLeast(CALENDAR_FEED_MANAGERS);
//
// useCan reads /me/capabilities, the server's own answer for this person
// (api/src/auth/effective-capabilities.ts): the admin tier holds everything,
// anyone else what their role, grants and the actions' own `runBy` give
// them, so what a page draws is what the server allows. It is asked once per
// workspace and shared by every control on every page.
import { useQuery } from "@tanstack/react-query";
import { roleSatisfies, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { useContext } from "react";
import { PlatformWebContext } from "./context";

/** The server's answer (GET /orgs/:slug/me/capabilities). */
export interface MyCapabilities {
  role: string;
  /** The admin tier: every action, without a list. */
  all: boolean;
  grants: string[];
}

/** One cache entry per workspace, shared by every page that asks. */
export const myCapabilitiesKey = (slug: string) => ["my-capabilities", slug] as const;

/** Where the answer comes from: the provider's workspace and api by default;
 *  the web app passes its own (web/src/lib/can.ts), so a page drawn outside
 *  the provider asks the same way and shares the same cache entry. */
export interface CapabilitySource {
  slug: string | null | undefined;
  ask?: (slug: string) => Promise<MyCapabilities>;
  role?: string | null;
}

/** What this person may do here, or null until it is known (or outside a
 *  workspace, where there is no one to ask). */
export function useCapabilities(source?: CapabilitySource): MyCapabilities | null {
  const ctx = useContext(PlatformWebContext);
  const slug = (source ? source.slug : ctx?.orgSlug) ?? "";
  const ask = source?.ask ?? ctx?.api.getMyCapabilities;
  const q = useQuery({
    queryKey: myCapabilitiesKey(slug),
    queryFn: () => ask!(slug),
    enabled: !!slug && !!ask,
    staleTime: 60_000,
  });
  return q.data ?? null;
}

/** Does `caps` let this person run `action`? */
export function capabilityAllows(caps: Pick<MyCapabilities, "all" | "grants"> | null | undefined, action: string): boolean {
  return !!caps && (caps.all === true || (caps.grants ?? []).includes(action));
}

/** May the viewer run `action`? null while the answer is on its way: draw
 *  nothing yet rather than a control that may be refused. */
export function useCan(action: string, source?: CapabilitySource): boolean | null {
  const caps = useCapabilities(source);
  return caps ? capabilityAllows(caps, action) : null;
}

/** Does the viewer's role reach one of `roles`, as a route's requireRole
 *  judges it? The list comes from the contract (org-roles.ts), the same one
 *  the route reads, never spelled out on the page. */
export function useRoleAtLeast(roles: readonly OrgRoleName[], source?: Pick<CapabilitySource, "role">): boolean {
  const ctxRole = useContext(PlatformWebContext)?.role ?? null;
  return roleSatisfies(source ? source.role : ctxRole, roles);
}
