// Shared helpers for the inventory route handlers.

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { tenantContext, type OrgRole } from "../db.js";

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
  if (!allowed.includes(ctx.role)) {
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
