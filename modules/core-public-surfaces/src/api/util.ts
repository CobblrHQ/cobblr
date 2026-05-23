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
    error: { code: "invalid_body", message, details: err.issues },
  });
}

export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const ctx = tenantContext(req);
  if (!allowed.includes(ctx.role)) {
    res.status(403).json({
      error: { code: "forbidden", message: `Requires one of: ${allowed.join(", ")}.` },
    });
    return false;
  }
  return true;
}

/** Cryptographically-random URL-safe token, ~40 chars. Enough entropy
 *  (256-bit secret) for "anyone with this URL" semantics. */
export function mintToken(): string {
  // node's webcrypto is available in node 22+; avoids pulling in
  // node:crypto's Buffer for base64url.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, strip padding.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
