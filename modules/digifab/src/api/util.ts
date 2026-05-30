import type { Request, Response, NextFunction } from "express";
import type { z } from "zod";

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
  ...allowed: Array<"owner" | "admin" | "member" | "guest">
): boolean {
  const role = (req as unknown as { tenant?: { role: string } }).tenant?.role;
  if (!role || !allowed.includes(role as "owner")) {
    res.status(403).json({
      error: { code: "forbidden", message: `Requires one of: ${allowed.join(", ")}` },
    });
    return false;
  }
  return true;
}
