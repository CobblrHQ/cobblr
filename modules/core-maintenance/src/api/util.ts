import { MaintenanceRefusal } from "../refusal.js";
import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";
import { roleSatisfies, roleRefusal } from "@cobblr/platform-contract/org-roles";
import type { OrgRoleName as OrgRole } from "@cobblr/platform-contract/org-roles";

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch((error) => {
      if (error instanceof MaintenanceRefusal) { res.status(error.status).json({ error: { code: "invalid_input", message: error.message } }); return; }
      next(error);
    });
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
