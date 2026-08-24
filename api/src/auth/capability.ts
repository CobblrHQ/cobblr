// Kernel-side authorization gates for api/src/routes handlers.
//
// Mirror of modules/*/src/api/util.ts (which serve module routers). The
// express plumbing is duplicated because the kernel app's routes can't
// import a module's internals and modules can't import the kernel app.
//
// The ROLE RANKING is not duplicated any more. It lives in
// @cobblr/platform-contract/org-roles, because the copies drifted: the
// kernel's was rank-based and all 34 module copies were exact-set, so an
// `editor` could read a workspace and write nothing in it. Duplicating
// plumbing is cheap; duplicating a RULE is how you get 34 of them.
//
// Compose AFTER requireAuth + withTenant (they populate req.session +
// req.tenant). Each returns true to continue, or writes a 4xx and
// returns false:
//   if (!requireRole(req, res, "owner", "admin")) return;
//   if (!(await requireCapability(req, res, "inventory:adjust-stock"))) return;

import type { Request, Response } from "express";
import { platform } from "@cobblr/platform-contract";
import type { OrgRole } from "../db/schema.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

// The ranking moved to @cobblr/platform-contract/org-roles, because every
// module had written its own copy and all 34 of them got it wrong in the same
// direction — an exact-set test that silently excluded `editor` from every
// write. One table, imported by both halves, is the only version of this that
// cannot drift again.

/** Gate by org role (rank-based — a higher role always satisfies a lower
 *  requirement). Guest is never in an `allowed` set for a mutation, so this
 *  also enforces the "guest = read-only" invariant. */
export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const role = req.tenant?.role;
  if (!roleSatisfies(role, allowed)) {
    res.status(403).json({
      error: { code: "forbidden", message: `This action requires one of: ${allowed.join(", ")}.` },
    });
    return false;
  }
  return true;
}

/** Gate by a specific action capability. Owner/admin pass implicitly;
 *  members/guests need an explicit grant (workspace_capability_grants
 *  or a custom-role bundle) — see platform().auth.userHasCapability.
 *  docs/modules/member-portal-and-permissions.md. */
export async function requireCapability(
  req: Request,
  res: Response,
  actionId: string,
): Promise<boolean> {
  const tenant = req.tenant;
  const session = req.session;
  if (!tenant || !session) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Auth required." } });
    return false;
  }
  const ok = await platform().auth.userHasCapability({
    orgId: tenant.org.id,
    userId: session.id,
    role: tenant.role,
    actionId,
  });
  if (!ok) {
    res.status(403).json({
      error: {
        code: "missing_capability",
        message: `This action requires the ${actionId} capability. Ask a workspace admin to grant it.`,
        details: { action_id: actionId, your_role: tenant.role },
      },
    });
    return false;
  }
  return true;
}
