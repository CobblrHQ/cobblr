import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sessionUser, tenantContext, type OrgRole } from "../db.js";
import { platform } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

export function asyncHandler<R extends Request = Request>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req as R, res, next).catch(next);
  };
}

export function badBody(res: Response, err: z.ZodError, message = "Bad request body"): void {
  res.status(400).json({
    error: { code: "invalid_body", message, details: err.issues },
  });
}

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

/** Refuse with the platform's blocked-action answer unless the caller holds
 *  `actionId` (the admin tier always does). The refusal carries
 *  `error.blocked`, which the page turns into "Ask an admin", and the kept
 *  request replays this call once someone says yes. */
export async function requireCapability(req: Request, res: Response, actionId: string): Promise<boolean> {
  const ctx = tenantContext(req);
  const who = { orgId: ctx.org.id, userId: sessionUser(req)?.id ?? "", role: ctx.role, actionId };
  if (await platform().auth.userHasCapability(who)) return true;
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({ error: { code: "missing_capability", message: blocked.sentence, details: { action_id: actionId, your_role: ctx.role }, blocked } });
  return false;
}
