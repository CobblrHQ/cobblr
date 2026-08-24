// core-placement owns no tenant table access of its own — the placement store
// is read/written through platform().placement. These helpers just pull the
// tenant context (org + role + session user) off the request the platform
// pre-populates, so the router can scope + authorize.

import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-placement route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
