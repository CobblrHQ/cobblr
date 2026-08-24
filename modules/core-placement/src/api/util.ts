import type { Request, Response } from "express";
import { tenantContext, type OrgRole } from "../db.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** Gate a mutating route on the caller's org role. Sends a 403 and returns
 *  false when the role isn't allowed; the handler bails on false. Mirrors the
 *  sibling modules' util so a read-only guest can never mutate placement. */
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
