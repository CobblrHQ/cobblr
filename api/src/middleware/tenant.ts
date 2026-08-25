// Tenant routing middleware. Composes after requireAuth — looks up
// the org by slug (from path param or header), verifies the session
// user is a member, attaches { org, role, db } to the request.
//
// Modules will compose this onto their own routers in later phases.

import type { NextFunction, Request, Response } from "express";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { verifyImpersonation } from "../auth/jwt.js";
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

/** Set ONLY when the request is served under an operator impersonation grant
 *  (a valid X-Impersonation token). The operator's own identity still rides the
 *  Bearer (`req.session`); `req.tenant.role` is the TARGET's role. */
export interface RequestImpersonation {
  operatorId: string;
  targetId: string;
  sessionId: string;
  mode: "read" | "write";
}

declare module "express-serve-static-core" {
  interface Request {
    tenant?: RequestTenant;
    impersonation?: RequestImpersonation;
  }
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when a workspace request must be refused because the user still
 *  carries a temp/admin-set password (audit L-MUSTRESET). Reads (GET/HEAD)
 *  pass so the reset page can still load its data; every mutation is blocked
 *  until the reset completes. The reset flow itself never hits this: both
 *  POST /me/password and /auth/password/reset are meta-level routes that do
 *  not go through withTenant. Pure so it's unit-testable without a DB. */
export function blocksForPasswordReset(mustReset: boolean, method: string): boolean {
  if (!mustReset) return false;
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
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
  // Forced password reset is enforced HERE, not just by the client redirect:
  // a user on a temp password can read (so the shell/reset page loads) but
  // cannot mutate workspace data until they set their own password.
  if (blocksForPasswordReset(req.session.must_reset_password, req.method)) {
    res.status(403).json({
      error: { code: "must_reset_password", message: "Reset your password before continuing." },
    });
    return;
  }
  const slug = resolveSlug(req);
  if (!slug) {
    res
      .status(400)
      .json({ error: { code: "missing_org", message: "Org slug required (path param or X-Org-Slug header)" } });
    return;
  }

  // Operator impersonation: a valid X-Impersonation token resolves the tenant as
  // the TARGET member (their role/grants/field-scopes), read-only unless write
  // mode is armed. The operator's own Bearer still identifies them in req.session.
  const impToken = req.header("X-Impersonation");
  if (impToken) {
    await resolveImpersonatedTenant(req, res, next, slug, impToken);
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
    // A signup returns 201 even when tenant provisioning failed (the org row is
    // kept so an operator can re-provision) — so this 503 means "that org's
    // CREATE DATABASE / migrations never landed", not "still warming up". Name
    // the org here so a bare 503 in a log (e.g. the CI flake, issue #765) points
    // straight at the unprovisioned workspace instead of being a mystery.
    console.warn(
      `[tenant] 503 tenant_unprovisioned: org ${row.org_id} (${slug}) has NULL db_credentials_encrypted — provisioning failed at signup`,
    );
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

/** Resolve tenant context for an impersonated request. Verifies the grant, swaps
 *  in the target member's role, enforces read-only (unless write mode is armed),
 *  and stamps req.impersonation. Every guard is server-side — the client banner
 *  is disclosure, not security. */
async function resolveImpersonatedTenant(
  req: Request,
  res: Response,
  next: NextFunction,
  slug: string,
  token: string,
): Promise<void> {
  let claims;
  try {
    claims = await verifyImpersonation(token);
  } catch {
    res.status(401).json({ error: { code: "impersonation_expired", message: "Impersonation session expired or invalid." } });
    return;
  }
  // The token must belong to the operator making the call (their Bearer session).
  if (!req.session || claims.sub !== req.session.id) {
    res.status(403).json({ error: { code: "impersonation_mismatch", message: "Impersonation token does not match the authenticated operator." } });
    return;
  }
  // Re-check platform-admin on THIS request, not just at mint time. is_platform_admin
  // is recomputed from SUPERADMIN_EMAILS every request, so an operator removed from
  // that list stops impersonating immediately rather than riding an outstanding
  // token for up to its 60-minute TTL (audit L-IMPADMIN).
  if (!req.session.is_platform_admin) {
    res.status(403).json({ error: { code: "impersonation_revoked", message: "Operator is no longer a platform admin." } });
    return;
  }
  const sess = await meta
    .selectFrom("impersonation_sessions")
    .select(["id", "org_id", "mode", "ended_at", "expires_at"])
    .where("id", "=", claims.sid)
    .executeTakeFirst();
  if (!sess || sess.ended_at || new Date(sess.expires_at).getTime() <= Date.now()) {
    res.status(401).json({ error: { code: "impersonation_expired", message: "Impersonation session has ended or expired." } });
    return;
  }
  // Resolve the org by slug + the TARGET member's role in it.
  const row = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id as org_id", "o.name as org_name", "o.slug as org_slug", "o.db_credentials_encrypted", "o.plan", "m.role"])
    .where("m.user_id", "=", claims.act)
    .where("o.slug", "=", slug)
    .executeTakeFirst();
  if (!row) {
    res.status(404).json({ error: { code: "org_not_found", message: "Org not found, or the target is not a member." } });
    return;
  }
  // Token org claim + session row must match the resolved workspace.
  if (row.org_id !== claims.org || row.org_id !== sess.org_id) {
    res.status(403).json({ error: { code: "impersonation_scope", message: "Impersonation token is scoped to a different workspace." } });
    return;
  }
  if (row.plan === "disabled") {
    res.status(403).json({ error: { code: "workspace_disabled", message: "This workspace has been disabled by the platform operator." } });
    return;
  }
  if (!row.db_credentials_encrypted) {
    res.status(503).json({ error: { code: "tenant_unprovisioned", message: "Org's tenant DB hasn't been provisioned yet" } });
    return;
  }
  // Read-only enforcement, server-side, before any handler: a mutating method
  // under a non-write session is refused. Buttons hidden in the UI are courtesy;
  // THIS is the guarantee.
  if (!READ_METHODS.has(req.method) && sess.mode !== "write") {
    res.status(403).json({ error: { code: "impersonation_read_only", message: "This is a read-only support session. Enable editing to make changes." } });
    return;
  }
  // Amortized audit: bump the request counter (fire-and-forget).
  void meta
    .updateTable("impersonation_sessions")
    .set({ request_count: sql`request_count + 1` })
    .where("id", "=", sess.id)
    .execute()
    .catch(() => {});
  try {
    const db = await getTenantDb(row.org_id);
    req.tenant = { org: { id: row.org_id, name: row.org_name, slug: row.org_slug }, role: row.role, db };
    req.impersonation = { operatorId: claims.sub, targetId: claims.act, sessionId: sess.id, mode: sess.mode };
    next();
  } catch (err) {
    res.status(500).json({ error: { code: "tenant_unavailable", message: (err as Error).message } });
  }
}
