// Shared helpers for the inventory route handlers.

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, sessionUser, type OrgRole } from "../db.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** Wrap an async handler so thrown rejections route to next(err)
 *  instead of becoming an unhandled rejection. */
export function asyncHandler<R extends Request = Request>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req as R, res, next).catch(next);
  };
}

/** Translate a Zod validation failure into the platform's standard
 *  { error: { code, message, details } } shape. */
export function badBody(res: Response, err: z.ZodError, message = "Bad request body"): void {
  res.status(400).json({
    error: {
      code: "invalid_body",
      message,
      details: err.issues,
    },
  });
}

/** Gate a route by org role. Returns true to continue, false if it
 *  already wrote a 403 response. Usage:
 *    if (!requireRole(req, res, "owner", "admin")) return;
 *  Guest is never allowed for mutating operations regardless. */
export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const ctx = tenantContext(req);
  // RANK-BASED, from the contract, rather than an exact-set membership test.
  //
  // Every call site lists roles longhand starting at "owner", meaning "this
  // role or better". An exact-set test reads that as "exactly these", which
  // silently excluded `editor` from every write in this module: an editor could
  // read the workspace and change nothing in it. See platform-contract's
  // org-roles.ts for the whole story.
  if (!roleSatisfies(ctx.role, allowed)) {
    res.status(403).json({
      error: {
        code: "forbidden",
        message: `This action requires one of: ${allowed.join(", ")}.`,
      },
    });
    return false;
  }
  return true;
}

/** Gate a route by a specific action capability — admin/owner pass
 *  implicitly; members/guests need an explicit grant in
 *  workspace_capability_grants. Opt-in per action (default is still
 *  role-based gating). Usage:
 *    if (!(await requireCapability(req, res, "inventory:create-part"))) return;
 *  See docs/modules/member-portal-and-permissions.md. */
export async function requireCapability(
  req: Request,
  res: Response,
  actionId: string,
): Promise<boolean> {
  const ctx = tenantContext(req);
  const user = sessionUser(req);
  const ok = await platform().auth.userHasCapability({
    orgId: ctx.org.id,
    userId: user.id,
    role: ctx.role,
    actionId,
  });
  if (!ok) {
    res.status(403).json({
      error: {
        code: "missing_capability",
        message: `This action requires the ${actionId} capability. Ask a workspace admin to grant it.`,
        details: { action_id: actionId, your_role: ctx.role },
      },
    });
    return false;
  }
  return true;
}

/** Normalise free-text → URL-safe slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
