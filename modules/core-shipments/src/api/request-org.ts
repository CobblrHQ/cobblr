// Who is asking, and on whose behalf.
//
// This exists because getting it wrong is SILENT. The tenant middleware sets
// `req.tenant.org.id`; there is no `req.org`. A route that reached for the
// latter got `undefined`, fell back to "", and then every downstream decision
// that needed a workspace quietly had none.
//
// That shipped: `/status` read `req.org?.id`, so asking Cobblr to check a parcel
// through an edge bridge failed with "no workspace context to route to a
// bridge" — on an instance where the bridge was connected and working. The
// value was empty the whole time and nothing anywhere said so.
//
// So the shape is read in ONE place, and `lint:request-org` stops a route
// reaching into the request for it again.

import type { Request } from "express";

/** What the platform actually puts on an authenticated, tenant-resolved request. */
interface TenantRequest {
  tenant?: { org?: { id?: string } };
  session?: { id?: string };
}

export interface RequestOrg {
  /** The workspace this request is scoped to. Empty only if the route was
   *  mounted without the tenant middleware, which would be a wiring bug. */
  orgId: string;
  /** The authenticated user, or null for a token with no user. */
  userId: string | null;
}

export function requestOrg(req: Request): RequestOrg {
  const r = req as unknown as TenantRequest;
  return {
    orgId: r.tenant?.org?.id ?? "",
    userId: r.session?.id ?? null,
  };
}
