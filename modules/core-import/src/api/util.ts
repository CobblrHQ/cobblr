import type { Request, Response } from "express";

/** Gate a write route to the given org roles (403 + false otherwise). The
 *  downstream module endpoints re-enforce their own create-capability under the
 *  caller's bearer, so this is the front-door check. */
export function requireRole(
  req: Request,
  res: Response,
  ...allowed: Array<"owner" | "admin" | "member" | "guest">
): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (!role || !allowed.includes(role as "owner")) {
    res.status(403).json({ error: { code: "forbidden", message: `Requires one of: ${allowed.join(", ")}` } });
    return false;
  }
  return true;
}
