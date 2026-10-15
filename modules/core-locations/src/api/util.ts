// Shared request helpers — same shape every module uses.

import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { roleSatisfies, roleRefusal } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName as OrgRole } from "@cobblr/platform-contract/org-roles";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext } from "../db.js";

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function badBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: { code: "invalid_body", message: "Bad request body", details: error.issues },
  });
}

export function requireRole(
  req: Request,
  res: Response,
  ...allowed: OrgRole[]
): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (!role || !roleSatisfies(role as "owner", allowed)) {
    res.status(403).json({
      error: { code: "forbidden", message: roleRefusal(allowed) },
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
  const user = sessionUser(req);
  const who = { orgId: ctx.org.id, userId: user.id, role: ctx.role, actionId };
  if (await platform().auth.userHasCapability(who)) return true;
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({
    error: {
      code: "missing_capability",
      message: blocked.sentence,
      details: { action_id: actionId, your_role: ctx.role },
      blocked,
    },
  });
  return false;
}
