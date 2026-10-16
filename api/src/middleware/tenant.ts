// Tenant routing middleware. Composes after requireAuth — looks up
// the org by slug (from path param or header), verifies the session
// user is a member, attaches { org, role, db } to the request.
//
// Modules will compose this onto their own routers in later phases.

import { describeGuestWrite } from "../platform/approvals.js";
import { guestMayRead, guestMayWrite, guestRouteKey, portalShares } from "../auth/guest-reads.js";
import { holdForAPerson } from "../platform/ai-held-changes.js";
import { sandboxIsOver, trialIsOver } from "../platform/sandbox-over.js";
import { sandboxEnabled } from "../platform/try-sandbox.js";
import type { NextFunction, Request, Response } from "express";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, WorkspaceDeletingError } from "../db/tenant.js";
import { verifyImpersonation } from "../auth/jwt.js";
import { currentActor } from "../lib/request-context.js";
import { noteActiveDay } from "../platform/product-events.js";
import type { OrgRole } from "../db/schema.js";
import { servedShapeVersion, WORKSPACE_SHAPE_HEADER } from "../platform/workspace-shape.js";
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

/** Does a support ("View as") session refuse this request?
 *
 *  Exported so the promise can be tested directly. The guarantee is not "the
 *  console hides the buttons" - it is that an operator looking at someone
 *  else's workspace CANNOT change it unless write mode was deliberately armed.
 *  A regression here is silent: reads keep working, and the first sign is an
 *  edit nobody made appearing in a stranger's data.
 *
 *  Kept as a pure decision rather than an inline condition so the read set can
 *  be pinned by name. Widening READ_METHODS is the realistic way this breaks -
 *  PATCH looks harmless in a list of verbs until it is the one deleting rows.
 */
export function supportSessionRefuses(method: string, mode: string): boolean {
  return !READ_METHODS.has(method) && mode !== "write";
}

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

/** What a person hears about a workspace whose database was never made. */
export const UNPROVISIONED_MESSAGE = "This workspace is not set up yet. Finish setting it up from its page.";

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
      "o.sandbox",
      "o.trial_expires_at",
      "o.shape_version",
      "o.portal_config",
      "m.role",
    ])
    .where("m.user_id", "=", req.session.id)
    .where("o.slug", "=", slug)
    .executeTakeFirst();

  if (!row) {
    res.status(404).json({ error: { code: "org_not_found", message: "Org not found" } });
    return;
  }
  // A no-account sandbox past its hour is over, whether or not the reaper has
  // swept it yet (it runs every few minutes). Until this check, the session
  // kept working for that whole window: the page showed "your hour is up, this
  // sandbox was deleted" over a dashboard that still answered, the visitor
  // could keep adding things to a database about to be dropped, and once it
  // WAS dropped every read failed in a different way. One answer, from here on
  // every tenant route: 410, with the code the web turns into the ending.
  if (sandboxIsOver(row)) {
    res.status(410).json({
      error: { code: "sandbox_expired", message: "This sandbox's hour is up." },
    });
    return;
  }
  // A kept trial past the length the person chose, on the box that hands out
  // sandboxes only (#3254). Its own code: the web draws a different ending.
  if (sandboxEnabled() && trialIsOver(row)) {
    res.status(410).json({
      error: { code: "trial_expired", message: "This trial has ended." },
    });
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
    // A workspace whose database was never made: signup no longer answers 201
    // for one (provisionWholeOrRemove), so this is one left by older code or a
    // process that died mid-signup. The app shows "not set up yet" with a
    // button to finish it (POST /orgs/:slug/finish-setup), and the boot heal
    // finishes it too. Named in the log so a bare 503 points straight at it.
    console.warn(
      `[tenant] 503 tenant_unprovisioned: org ${row.org_id} (${slug}) has NULL db_credentials_encrypted`,
    );
    res.status(503).json({
      error: {
        code: "tenant_unprovisioned",
        message: UNPROVISIONED_MESSAGE,
      },
    });
    return;
  }

  try {
    const db = await getTenantDb(row.org_id);
    // A guest reads what the workspace shares in its portal, not the
    // workspace itself, and changes only what auth/guest-reads.ts names.
    const readOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    if (row.role === "guest" && !readOnly) {
      const key = guestRouteKey(req.baseUrl, req.route?.path as string | undefined, req.path, slug);
      if (!guestMayWrite(req.method, key)) {
        res.status(403).json({
          error: {
            code: "guest_read_only",
            message: "A guest can look at what this workspace shares, and ask for more, but cannot change it.",
            blocked: await describeGuestWrite(row.org_id, req.session!.id),
          },
        });
        return;
      }
    }
    if (row.role === "guest" && readOnly) {
      let shared: Promise<{ views: Set<string>; kinds: Set<string> }> | null = null;
      const shares = () => (shared ??= portalShares(row.portal_config, db as unknown as Kysely<unknown>));
      const fileKinds = async (fileId: string) => {
        const { rows } = await sql<{ k: string }>`select source_module || ':' || source_type as k from core_files_attachments where file_id::text = ${fileId}`
          .execute(db)
          .catch(() => ({ rows: [] as { k: string }[] }));
        return rows.map((r) => r.k);
      };
      const key = guestRouteKey(req.baseUrl, req.route?.path as string | undefined, req.path, slug);
      if (!(await guestMayRead(key, req.route ? (req.params as Record<string, string>) : {}, shares, fileKinds))) {
        res.status(403).json({
          error: { code: "guest_not_shared", message: "A guest sees what this workspace shares in its portal, and this is not part of it." },
        });
        return;
      }
    }
    serveShapeVersion(res, row.org_id, row.shape_version);
    req.tenant = {
      org: { id: row.org_id, name: row.org_name, slug: row.org_slug },
      role: row.role,
      db,
    };
    const { protectSecretResponses } = await import("../platform/secret-field-responses.js");
    await protectSecretResponses(req, res, next);
    // A person touching their workspace today is the retention fact the
    // activation funnel is built on. Sessions only: an API token is an
    // integration or an edge device polling, not someone coming back.
    if (currentActor()?.authMethod === "session") noteActiveDay(row.org_id, req.session.id);
    // An assistant's delete waits for its person (ai-held-changes.ts). Here,
    // because every workspace route passes this door.
    if (req.method === "DELETE" && req.session.ai_door) {
      await holdForAPerson(req, res);
      return;
    }
    next();
  } catch (err) {
    if (err instanceof WorkspaceDeletingError) {
      res.status(409).json({
        error: { code: "workspace_deleting", message: "This workspace is being deleted." },
      });
      return;
    }
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
    .select(["o.id as org_id", "o.name as org_name", "o.slug as org_slug", "o.db_credentials_encrypted", "o.plan", "o.shape_version", "m.role"])
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
    res.status(503).json({ error: { code: "tenant_unprovisioned", message: UNPROVISIONED_MESSAGE } });
    return;
  }
  // Read-only enforcement, server-side, before any handler: a mutating method
  // under a non-write session is refused. Buttons hidden in the UI are courtesy;
  // THIS is the guarantee.
  if (supportSessionRefuses(req.method, sess.mode)) {
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
    serveShapeVersion(res, row.org_id, row.shape_version);
    req.tenant = { org: { id: row.org_id, name: row.org_name, slug: row.org_slug }, role: row.role, db };
    req.impersonation = { operatorId: claims.sub, targetId: claims.act, sessionId: sess.id, mode: sess.mode };
    const { protectSecretResponses } = await import("../platform/secret-field-responses.js");
    await protectSecretResponses(req, res, next);
    next();
  } catch (err) {
    if (err instanceof WorkspaceDeletingError) {
      res.status(409).json({ error: { code: "workspace_deleting", message: "This workspace is being deleted." } });
      return;
    }
    res.status(500).json({ error: { code: "tenant_unavailable", message: (err as Error).message } });
  }
}

/** Stamp the workspace's shape version on the response as its head is written,
 *  not now: the handler may change the shape (an install, often in a nested
 *  request) before it answers, and the answer must carry the version after
 *  that (platform/workspace-shape.ts). */
function serveShapeVersion(res: Response, orgId: string, readAtStart: number): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    if (!this.headersSent) this.setHeader(WORKSPACE_SHAPE_HEADER, String(servedShapeVersion(orgId, readAtStart)));
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.writeHead;
}
