// Tenant routing middleware. Composes after requireAuth — looks up
// the org by slug (from path param or header), verifies the session
// user is a member, attaches { org, role, db } to the request.
//
// Modules will compose this onto their own routers in later phases.

import type { NextFunction, Request, Response } from "express";
import type { Kysely } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import type { OrgRole } from "../db/schema.js";
import type { TenantDB } from "../db/tenant-schema.js";

export interface RequestTenant {
  org: {
    id: string;
    name: string;
    slug: string;
  };
  role: OrgRole;
  db: Kysely<TenantDB>;
}

declare module "express-serve-static-core" {
  interface Request {
    tenant?: RequestTenant;
  }
}

/** Reads org slug from `req.params.slug` (route param) or the
 *  `X-Org-Slug` header. Returns 400 if neither is present. */
function resolveSlug(req: Request): string | null {
  const fromParam = req.params.slug;
  if (typeof fromParam === "string" && fromParam.length > 0) return fromParam;
  const fromHeader = req.header("X-Org-Slug");
  if (fromHeader && fromHeader.length > 0) return fromHeader;
  return null;
}

export async function withTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.session) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Auth required" } });
    return;
  }
  const slug = resolveSlug(req);
  if (!slug) {
    res
      .status(400)
      .json({ error: { code: "missing_org", message: "Org slug required (path param or X-Org-Slug header)" } });
    return;
  }

  const row = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select([
      "o.id as org_id",
      "o.name as org_name",
      "o.slug as org_slug",
      "o.db_credentials_encrypted",
      "o.plan",
      "m.role",
    ])
    .where("m.user_id", "=", req.session.id)
    .where("o.slug", "=", slug)
    .executeTakeFirst();

  if (!row) {
    res.status(404).json({ error: { code: "org_not_found", message: "Org not found" } });
    return;
  }
  // Operator-disabled workspace: every tenant-scoped call is refused (the
  // console's disable toggle is only honest because of this check). The
  // meta-level session/login still works — the user sees a clear error
  // instead of a silent void, and re-enabling restores everything.
  if (row.plan === "disabled") {
    res.status(403).json({
      error: {
        code: "workspace_disabled",
        message: "This workspace has been disabled by the platform operator.",
      },
    });
    return;
  }
  if (!row.db_credentials_encrypted) {
    res.status(503).json({
      error: {
        code: "tenant_unprovisioned",
        message: "Org's tenant DB hasn't been provisioned yet",
      },
    });
    return;
  }

  try {
    const db = await getTenantDb(row.org_id);
    req.tenant = {
      org: { id: row.org_id, name: row.org_name, slug: row.org_slug },
      role: row.role,
      db,
    };
    next();
  } catch (err) {
    res.status(500).json({
      error: { code: "tenant_unavailable", message: (err as Error).message },
    });
  }
}
