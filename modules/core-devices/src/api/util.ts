import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { roleSatisfies, roleRefusal } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName as OrgRole } from "@cobblr/platform-contract/org-roles";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function badBody(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: { code: "invalid_body", message: invalidBodyMessage(error.issues), details: error.issues },
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

/** The signed-in person behind a request, or null for none. */
export function sessionUserId(req: Request): string | null {
  return (req as unknown as { session?: { id: string } }).session?.id ?? null;
}

/** Refuse with the platform's blocked-action answer unless the caller may run
 *  `actionId` themselves: a link or a reading is that action done for them. */
export async function requireMayRun(req: Request, res: Response, actionId: string): Promise<boolean> {
  const t = (req as unknown as { tenant?: { org: { id: string }; role: string } }).tenant;
  const userId = sessionUserId(req);
  if (!t || !userId) {
    res.status(403).json({ error: { code: "forbidden", message: "Sign in to do this." } });
    return false;
  }
  const who = { orgId: t.org.id, userId, role: t.role, actionId };
  if (await platform().auth.userHasCapability(who)) return true;
  const blocked = await platform().auth.describeBlockedCapability(who);
  res.status(403).json({
    error: { code: "missing_capability", message: blocked.sentence, details: { action_id: actionId, your_role: t.role }, blocked },
  });
  return false;
}
