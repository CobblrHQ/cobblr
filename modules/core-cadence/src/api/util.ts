import type { Request, Response } from "express";
import { tenantContext, type OrgRole } from "../db.js";

/** Gate a mutating route on the caller's org role. Sends a 403 and returns
 *  false when the role isn't allowed; the handler bails on false. Mirrors the
 *  sibling modules' util so a read-only guest can never mutate placement. */
export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const ctx = tenantContext(req);
  if (!allowed.includes(ctx.role)) {
    res.status(403).json({
      error: { code: "forbidden", message: `This action requires one of: ${allowed.join(", ")}.` },
    });
    return false;
  }
  return true;
}
