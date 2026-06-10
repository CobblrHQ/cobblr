// Auth middleware. Reads Bearer <jwt>, verifies, looks up the user,
// and attaches a typed `req.session` to the request.
//
// The handler doesn't care about org context — that's the job of
// tenant routing (milestone 3). Here we just establish "who is this
// person and are they still active."

import type { NextFunction, Request, Response } from "express";
import { meta } from "../db/meta.js";
import { verifySession } from "./jwt.js";
import { resolveApiToken } from "./api-tokens.js";
import { tokenScopeAllows } from "./scopes.js";
import { runWithActor } from "../lib/request-context.js";
import { env } from "../env.js";

// Parse SUPERADMIN_EMAILS once at module load. Comma-separated list
// of emails that get the platform-admin flag on every request.
const SUPERADMIN_EMAILS: Set<string> = new Set(
  (env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
export function isPlatformAdmin(email: string): boolean {
  return SUPERADMIN_EMAILS.has(email.toLowerCase());
}

export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
  /** How this request was authenticated — set by requireAuth. */
  auth_method: "session" | "api_token";
  /** If auth_method === "api_token", the id of the token that signed
   *  the request. Used for the activity-log audit trail. */
  api_token_id: string | null;
  /** True when the user's email is in SUPERADMIN_EMAILS. Gates the
   *  /super-admin/* surface. Per-workspace roles are unaffected;
   *  this is a SEPARATE tier above admin/owner. */
  is_platform_admin: boolean;
  /** Set when the request was authenticated with an H1 Tier-B
   *  capability-scoped app token (`aud: app:<slug>`): the app slug it
   *  was minted for. Null for a normal session / API token. Such a
   *  request is clamped server-side to the Tier-B allowlist (see
   *  `appTokenPathAllowed`). */
  app_scope: string | null;
  /** Capability scopes of the API token that signed this request, when it
   *  was minted with restrictions. Null = unrestricted (session, or a legacy
   *  full-access token). When non-null, requireAuth has already clamped the
   *  request to these scopes' allowlist (`tokenScopeAllows`). */
  token_scopes: string[] | null;
}

// H1 Tier B — server-side clamp for capability-scoped app tokens. The
// App Player's client-side mediator already restricts what a sandboxed
// bundle can request; this is the defense-in-depth twin so the boundary
// doesn't live only in browser JS. An app token may ONLY hit the same
// H2-scoped read surfaces + the one capability-gated action endpoint the
// mediator allows. Everything else (raw module writes, token minting,
// admin surfaces, …) is 403, even though the token carries the member's
// identity. Mirror of the allowlist in web `AppPlayerPage.tsx`.
function orgRelativePath(originalUrl: string): string | null {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  const m = path.match(/^\/api\/v1\/orgs\/[^/]+(\/.*)?$/);
  if (!m) return null; // not an org-scoped path → not reachable by an app token
  return m[1] ?? "/";
}
function appTokenPathAllowed(method: string, rel: string, appScope: string): boolean {
  if (rel.includes("..")) return false;
  // An app's OWN key/value scratchpad (cobblr.appLoad/appSave) — scoped to the
  // token's app slug so one app can't read/write another's bag.
  const ownData = new RegExp(`^/modules/core-apps/apps/${appScope.replace(/[^a-z0-9-]/gi, "")}/data/[a-z0-9_-]+$`).test(rel);
  if (method === "GET") {
    return (
      rel.startsWith("/modules/core-views/views") ||
      rel.startsWith("/entities/") ||
      rel.startsWith("/entity-kinds") ||
      rel === "/me/capabilities" ||
      // Workspace photos — an entity's image (core-files raw), so a sandboxed
      // app can render garment/part photos via the scoped token (member-bounded;
      // the raw handler enforces its own access). Read-only, GET-only.
      /^\/modules\/core-files\/files\/[^/]+\/raw(\?|$)/.test(rel) ||
      ownData
    );
  }
  if (method === "PUT") return ownData;
  if (method === "POST") return rel === "/actions/invoke";
  return false;
}

// Augment Express's Request without leaking the field globally —
// declare it here and import where needed.
declare module "express-serve-static-core" {
  interface Request {
    session?: SessionUser;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: { code: "unauthenticated", message: "Missing bearer token" } });
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    // Two acceptable token formats:
    //   1. Session JWT (issued by login/signup, browser-side).
    //   2. Long-lived API token `cbt_<...>` (minted via /me/api-tokens,
    //      used by CLI / AI / automation).
    // The `cbt_` prefix is unambiguous — JWTs always start with the
    // base64url of `{"alg":...` which begins `eyJ`.
    let userId: string | null = null;
    let authMethod: "session" | "api_token" = "session";
    let apiTokenId: string | null = null;
    let appScope: string | null = null;
    let tokenScopes: string[] | null = null;
    let tokenIssuedAt: number | null = null; // JWT iat (seconds), session/app only
    if (token.startsWith("cbt_")) {
      const resolved = await resolveApiToken(token);
      if (resolved) {
        userId = resolved.userId;
        authMethod = "api_token";
        apiTokenId = resolved.tokenId;
        tokenScopes = resolved.scopes;
      }
    } else {
      const claims = await verifySession(token);
      userId = claims.sub;
      tokenIssuedAt = typeof claims.iat === "number" ? claims.iat : null;
      if (typeof claims.aud === "string" && claims.aud.startsWith("app:")) {
        appScope = claims.aud.slice("app:".length);
      }
    }
    if (!userId) {
      res.status(401).json({
        error: { code: "unauthenticated", message: "Token not valid" },
      });
      return;
    }
    const user = await meta
      .selectFrom("users")
      .select(["id", "email", "display_name", "active", "tokens_valid_from"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user || !user.active) {
      res.status(401).json({
        error: { code: "unauthenticated", message: "User not found or inactive" },
      });
      return;
    }
    // Session revocation: reject a session/app JWT issued before the user's
    // last password change. API tokens (cbt_) have their own revoked_at and
    // carry no iat, so they're exempt here. Compared at second granularity
    // because JWT `iat` is whole seconds — so a token re-minted in the same
    // second as the cutoff (the self-service change re-mint) stays valid.
    // See 2026-06-10 audit #6.
    if (tokenIssuedAt !== null && user.tokens_valid_from) {
      const cutoffSec = Math.floor(new Date(user.tokens_valid_from).getTime() / 1000);
      if (tokenIssuedAt < cutoffSec) {
        res.status(401).json({
          error: { code: "session_revoked", message: "Session expired — please sign in again." },
        });
        return;
      }
    }
    // H1 Tier B — an app token is clamped to the Tier-B allowlist before
    // it can touch any handler. Server-side twin of the Player's
    // client-side mediator: the boundary holds even if that JS is bypassed.
    if (appScope) {
      const rel = orgRelativePath(req.originalUrl);
      if (rel === null || !appTokenPathAllowed(req.method, rel, appScope)) {
        res.status(403).json({
          error: {
            code: "app_token_out_of_scope",
            message:
              "This app token may only read H2-scoped views/entities and invoke capability-gated actions.",
          },
        });
        return;
      }
    }
    // Capability-scoped API token — DENY-by-default clamp to its scopes'
    // allowlist, before any handler runs. The token still carries the user's
    // full identity (incl. is_platform_admin), so this clamp is the ONLY thing
    // keeping a "feedback:triage" token out of every other admin surface.
    if (tokenScopes && !tokenScopeAllows(tokenScopes, req.method, req.originalUrl)) {
      res.status(403).json({
        error: {
          code: "token_out_of_scope",
          message:
            "This API token is capability-scoped and is not permitted to access this endpoint.",
        },
      });
      return;
    }
    req.session = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      auth_method: authMethod,
      api_token_id: apiTokenId,
      is_platform_admin: isPlatformAdmin(user.email),
      app_scope: appScope,
      token_scopes: tokenScopes,
    };
    // Wrap the rest of the request chain in actor context so any
    // deeply-nested activity.log() call automatically picks up
    // user id + auth method + token id.
    runWithActor(
      { userId: user.id, authMethod, apiTokenId },
      () => next(),
    );
  } catch (err) {
    res.status(401).json({
      error: { code: "unauthenticated", message: (err as Error).message },
    });
  }
}

/** Middleware: 403 anyone who isn't a platform admin. Use after
 *  `requireAuth` on routes scoped to /super-admin/*. */
export function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session?.is_platform_admin) {
    res.status(403).json({
      error: {
        code: "not_platform_admin",
        message: "Platform-admin only. Set SUPERADMIN_EMAILS to include your email.",
      },
    });
    return;
  }
  next();
}
