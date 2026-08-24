import type { Request, Response } from "express";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName as OrgRole } from "@cobblr/platform-contract/org-roles";

/** Gate a write route to the given org roles (403 + false otherwise). The
 *  downstream module endpoints re-enforce their own create-capability under the
 *  caller's bearer, so this is the front-door check. */
export function requireRole(
  req: Request,
  res: Response,
  ...allowed: OrgRole[]
): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (!role || !roleSatisfies(role as "owner", allowed)) {
    res.status(403).json({ error: { code: "forbidden", message: `Requires one of: ${allowed.join(", ")}` } });
    return false;
  }
  return true;
}
