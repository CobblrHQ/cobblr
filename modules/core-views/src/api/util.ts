import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { tenantContext, type OrgRole } from "../db.js";

export function asyncHandler<R extends Request = Request>(
  handler: (req: R, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req as R, res, next).catch(next);
  };
}

export function badBody(res: Response, err: z.ZodError, message = "Bad request body"): void {
  res.status(400).json({
    error: {
      code: "invalid_body",
      message,
      details: err.issues,
    },
  });
}

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
