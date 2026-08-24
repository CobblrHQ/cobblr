import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { tenantContext, type OrgRole } from "../db.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

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

/** Reject the caller unless their workspace role is in `allowed`. Read-only
 *  `guest` is excluded from every mutating handler. (Audit 2026-06-26 P0 #1.) */
export function requireRole(req: Request, res: Response, ...allowed: OrgRole[]): boolean {
  const ctx = tenantContext(req);
  // RANK-BASED, from the contract, rather than an exact-set membership test.
  //
  // Every call site lists roles longhand starting at "owner", meaning "this
  // role or better". An exact-set test reads that as "exactly these", which
  // silently excluded `editor` from every write in this module: an editor could
  // read the workspace and change nothing in it. See platform-contract's
  // org-roles.ts for the whole story.
  if (!roleSatisfies(ctx.role, allowed)) {
    res.status(403).json({
      error: { code: "forbidden", message: `This action requires one of: ${allowed.join(", ")}.` },
    });
    return false;
  }
  return true;
}

/** Substitute {{key}} tokens in a template with values from data.
 *  Missing keys → empty string. No conditionals; we're not building
 *  a real templating language. */
export function renderTemplate(tmpl: string, data: Record<string, unknown>): string {
  return tmpl.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
    const v = data[key];
    return v == null ? "" : String(v);
  });
}
