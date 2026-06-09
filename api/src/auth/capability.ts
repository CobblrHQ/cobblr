// Kernel-side authorization gates for api/src/routes handlers.
//
// Mirror of modules/inventory/src/api/util.ts (which serves module
// routers) — duplicated rather than shared because the kernel app's
// routes can't import a module's internals, and modules can't import
// the kernel app. Both wrap platform().auth.userHasCapability.
//
// Compose AFTER requireAuth + withTenant (they populate req.session +
// req.tenant). Each returns true to continue, or writes a 4xx and
// returns false:
//   if (!requireRole(req, res, "owner", "admin")) return;
//   if (!(await requireCapability(req, res, "inventory:adjust-stock"))) return;

import type { Request, Response } from "express";
import { platform } from "@cobblr/platform-contract";
import type { OrgRole } from "../db/schema.js";

// Action-gating rank. A more-privileged role satisfies any check a lesser one
// passes (every requireRole call site is hierarchical — they start at "owner").
// `editor` sits at admin-tier for ACTIONS: it does the full builder + config +
// data work. The two genuine governance gates are NOT rank-based — managing
// members goes through ADMINISH (owner/admin only) and deleting a workspace is
// owner-only — so editor is admin-minus-{manage-members, delete}.
const ROLE_RANK: Record<OrgRole, number> = {
  guest: 0,
  member: 1,
  editor: 2,
  admin: 2,
  owner: 3,
};

/** Gate by org role (rank-based — a higher role always satisfies a lower
 *  requirement). Guest is never in an `allowed` set for a mutation, so this
 *  also enforces the "guest = read-only" invariant. */
export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const role = req.tenant?.role;
  const need = allowed.length ? Math.min(...allowed.map((r) => ROLE_RANK[r] ?? 99)) : 99;
  const have = role ? (ROLE_RANK[role] ?? -1) : -1;
  if (have < need) {
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
