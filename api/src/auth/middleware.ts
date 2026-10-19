// Auth middleware. Reads Bearer <jwt>, verifies, looks up the user,
// and attaches a typed `req.session` to the request.
//
// The handler doesn't care about org context — that's the job of
// tenant routing (milestone 3). Here we just establish "who is this
// person and are they still active."

import { isMcpProxyCall } from "./mcp-proxy.js";
import { isSelfCall, selfCallAssistant } from "../platform/self-fetch.js";
import type { NextFunction, Request, Response } from "express";
import { meta } from "../db/meta.js";
import { TokenRefused, verifySession } from "./jwt.js";
import { errors as joseErrors } from "jose";
import { resolveApiToken } from "./api-tokens.js";
import { tokenAccessAllows, type TokenAccess } from "./token-access.js";
import { isStationQrScope, isStationScope, tokenScopeAllows } from "./scopes.js";
import { runWithActor, runVia, type Via } from "../lib/request-context.js";
import { linkOrigin } from "../platform/link-origin.js";
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
  /** The record kinds an app token's app declares it edits; empty for any
   *  other request. Limits the kernel verbs an app may fire
   *  (`appTokenInvokeRefusal`). */
  app_edit_kinds?: readonly string[];
  /** Capability scopes of the API token that signed this request, when it
   *  was minted with restrictions. Null = unrestricted (session, or a legacy
   *  full-access token). When non-null, requireAuth has already clamped the
   *  request to these scopes' allowlist (`tokenScopeAllows`). */
  token_scopes: string[] | null;
  /** A personal token's access level (token-access.ts); null = full, or not a token. */
  token_access?: TokenAccess | null;
  /** The one workspace a personal token is held to; null = every workspace. */
  token_org_id?: string | null;
  /** When the token that signed this request stops working (ISO); null = never, or not a token. */
  token_expires_at?: string | null;
  /** Set while the request is a View as through a share: the grant, the one
   *  workspace it is held to, and who is looking. Read-only, enforced above. */
  share_view?: { session_id: string; org_id: string; slug: string; viewer_name: string | null; expires_at: string } | null;
  /** True while the account carries a temp/admin-set password. Re-read from
   *  the DB on every request, so completing the reset (POST /me/password or
   *  /auth/password/reset) clears it immediately. `withTenant` refuses
   *  mutating workspace requests while this is set — the client redirect is
   *  UX, THIS is the enforcement (audit L-MUSTRESET). */
  must_reset_password: boolean;
  /** When a session/app JWT was issued (seconds); null for an API token. A
   *  change to how the person signs in, with no password to re-check, asks
   *  for a sign-in this recent (platform/email-change.ts). */
  issued_at?: number | null;
  /** The account's title format (the contract's TitleFormat), or null. */
  title_pref?: string | null;
  /** Set when an assistant makes this request through a door with no way to
   *  show a person a confirmation: "mcp" (the MCP endpoint's own calls, or an
   *  API token the MCP server marks as its own) or "relay" (the in-app chat's
   *  read/write grant). Decided from what signed the request, never from a
   *  client header alone, except that a header can only ever ADD it. */
  ai_door?: "mcp" | "relay" | null;
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

// The path clamp above lets an app token POST /actions/invoke, but says nothing
// about WHICH action — and the invoke route's only authz is requireCapability,
// which an owner/admin passes implicitly. So an app bundle running under an
// owner/admin identity could server-side fire a KERNEL workspace-config action
// (`platform:*` — disable-module, remove-field, rename-workspace) even though
// the Player's client-side mediator would never offer it. That mediator lives
// in browser JS and is bypassable; this is its server-side twin. An app token
// may invoke a capability-gated MODULE action but never a `platform:*` one.
// Enforced at the invoke route, where the actionId (request body) is known.
//
// A kernel verb an app may fire names the record kind it writes, and runs only
// on a kind the app declares it edits (its edit forms, carried in the token by
// core-apps at mint). The member's own grant is not enough: an app running as
// an owner would otherwise rewrite records of every updatable kind (#7408).
const APP_KERNEL_ACTION_KIND: Readonly<Record<string, (args: Record<string, unknown> | null) => string | null>> = {
  "platform:update-fields": (args) => (typeof args?.kind === "string" && args.kind ? args.kind : null),
};
export function appTokenInvokeRefusal(
  actionId: string,
  args: Record<string, unknown> | null,
  editKinds: readonly string[],
): string | null {
  if (!actionId.startsWith("platform:")) return null;
  const kindOf = APP_KERNEL_ACTION_KIND[actionId];
  if (!kindOf) return "An app token may not invoke workspace-configuration (platform:*) actions.";
  const kind = kindOf(args);
  if (!kind || !editKinds.includes(kind)) return "This app does not edit that kind of record. Add an edit form for it to the app.";
  return null;
}

// MCP read-grant clamp (Ask Cobb over the subscription bridge). A JWT with
// `aud: mcp-read:<slug>` carries the member's full identity, so — exactly like
// the app-token clamp above — this server-side allowlist is the ONLY thing
// keeping it from being a full session. DENY-by-default: GET only, pinned to the
// grant's own workspace slug, and only the read paths the shared tool registry
// actually fetches. A write (POST /actions/invoke) or any other workspace is
// 403, so "read-only" is enforced HERE, not just in the bridge's
// --allowed-tools.
//
// It stays an explicit list rather than "any GET in your own workspace": some
// workspace GETs return things a relayed bridge has no business holding (an
// integration's stored config, a member roster). Read-only is not the same as
// harmless.
//
// THIS LIST AND THE TOOL REGISTRY MUST AGREE, and a comment used to be the only
// thing saying so ("widen only when a new READ tool is added"). That is a
// reminder, not a guarantee — and it failed: the tool surface went from six
// tools to twenty-two while this list stayed at three path shapes, so sixteen
// read tools 403'd with `mcp_read_out_of_scope` the moment Cobb reached for
// them (2026-08-17). api/tests/mcp-read-grant.test.ts now DERIVES the
// requirement by running every read tool against a recording stub and asserting
// this clamp permits each path it fetches, so a new tool whose path the grant
// cannot reach fails a test instead of a user.
/** The GET paths the registry's READ tools fetch — kept beside the clamp so the
 *  two are read together. Exact strings or anchored patterns; nothing broader
 *  than a tool genuinely needs. */
const MCP_READ_PATHS: Array<string | RegExp> = [
  // records + the registry that describes them
  "/entity-kinds",
  "/registered-actions",
  /^\/modules\/digifab\/bench\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "/modules/digifab/floor",
  "/modules/digifab/fleet",
  // what each machine runs against its cohort's target (read_machine_versions),
  // in the machines module or one collection of it
  "/modules/machines/machines/versions",
  /^\/instances\/[a-z0-9_-]+\/items\/versions$/i,
  // finished prints and what they cost (read_print_history)
  "/modules/digifab/history",
  /^\/modules\/digifab\/kilns\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/modules\/digifab\/arms\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/modules\/digifab\/cells\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/modules\/digifab\/care\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "/modules/digifab/laser/profiles",
  "/modules/digifab/laser/plans",
  /^\/modules\/digifab\/laser\/design\/[A-Za-z0-9-]+$/,
  /^\/entities\//,
  "/pairings",
  // One person's things across every collection ("what does Alex own").
  "/people/things",
  // what is inside a container and where a thing is: list_related reads both
  // beside the pairings, so a relayed "what's in Bin 7" sees the bin's contents
  "/modules/core-placement/contents",
  "/modules/core-placement/of",
  // the locations tree: a garage holds its bins through core-locations' own
  // parent_id, which placement does not carry, so list_related reads it too
  "/modules/core-locations/locations",
  // what needs me / what happened / what is coming
  "/attention",
  // edits and additions people sharing with this workspace suggested (list_suggestions)
  "/suggestions",
  // the person's own push devices and why a notification did or did not reach
  // them (get_my_notification_delivery, #5267)
  "/my-push",
  "/feedback/mine",
  "/activity",
  "/notifications",
  // list_notifications reports the true unread total, not the page's
  "/notifications/unread-count",
  "/calendar/events",
  // the places this workspace already used on an address field (find_addresses)
  "/addresses",
  // how the workspace is set up
  "/instances",
  // who answers each AI job here and who reads personal documents
  // (get_workspace_setup, part ai): read only, never changed over MCP
  "/ai-job-order",
  "/personal-documents-reader",
  "/bindings",
  // how many records a wire would fire on, and the links a wire can run on
  "/bindings/preview",
  "/relationship-kinds",
  "/modules/core-views/views",
  // One view's rows as shown, its inputs set (read_view, #6897); the route
  // applies the view's own sharing, and an input never writes.
  /^\/modules\/core-views\/views\/[A-Za-z0-9-]+\/data$/,
  "/modules/core-apps/apps",
  "/modules/core-templates/templates",
  "/modules/core-units/units",
  // the capture queue, one item in full (get_scan_item: the id segment only,
  // never an item's own sub-routes), and its put-away plan
  /^\/modules\/core-scan\/inbox(\/stats|\/[A-Za-z0-9-]+)?$/,
  "/modules/core-scan/organize/plan/latest",
  "/scan-stations",
  /^\/scan-stations\/[0-9A-Fa-f-]{36}\/sessions(\/[0-9A-Fa-f-]{36})?$/,
  // the outside services usable here, and one job (list_services,
  // get_service_job); a job's confirm is never reachable from here
  "/services/capabilities",
  /^\/services\/capabilities\/[a-z0-9_-]+(\.[a-z0-9_-]+)+$/,
  /^\/services\/jobs\/[A-Za-z0-9-]+(\/trigger)?$/,
  // service history, cross-kind search, label codes
  "/modules/core-maintenance/entries",
  "/modules/core-search/search",
  "/modules/labels/codes/groups",
  // the user's own chat consent — the hosted MCP endpoint reads it to decide
  // whether to advertise (and run) the write tools at all, so it must be
  // reachable with the grant the relay actually carries.
  "/modules/core-ai/chat/prefs",
];

// MCP WRITE-grant clamp. A separate, 60-second grant the hosted MCP endpoint
// mints for ITSELF once it has confirmed the user's chat consent says writes
// apply automatically (write_mode: auto). It is never handed to the bridge.
//
// Deny-by-default in the same spirit as the read clamp, but the allowed set is
// a SHAPE rather than a list: a record's create/update/delete route is declared
// by its own module (entity_kinds.endpoints), so it is always org-relative
// `/modules/<module>/…` or `/instances/<instance>/…`. Nothing else is a record
// route, which structurally excludes the platform families that would be an
// escalation — /api-tokens, /members, /integrations, /settings and bare
// /modules (enable/disable).
//
// The ONE platform path added to that shape is `/actions/invoke`. It was
// excluded on the reasoning that an action always confirms and a relayed chat
// has nowhere to ask — which held until the confirmation question moved to the
// action itself (`undoable` in the manifest). By the time this clamp is
// reached, hosted-mcp has already established that the user's chat consent is
// "auto" AND that this particular action can be put right again; the grant is
// 60 seconds, minted in-process, never handed to the bridge, and the invoke
// route still applies requireCapability. Widening the SHAPE to admit it would
// have admitted every other platform route too, so it is named exactly.
// Starting a service job is a write the gate decides (services.md section 9);
// confirming one is a person's, in Cobblr, and is not here.
const MCP_WRITE_PLATFORM_PATHS = new Set(["/actions/invoke", "/services/jobs"]);
const MCP_WRITE_DENIED = /\/connections(\/|$)/; // credential-bearing module routes

export function mcpWritePathAllowed(method: string, originalUrl: string, slug: string): boolean {
  // Reads stay exactly as clamped for the read grant — a write tool resolves
  // its route by GETting /entity-kinds first.
  if (method === "GET") return mcpReadPathAllowed(method, originalUrl, slug);
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, "");
  if (!safeSlug) return false;
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  const prefix = `/api/v1/orgs/${safeSlug}`;
  if (!path.startsWith(prefix + "/")) return false; // pinned to THIS workspace
  const rel = path.slice(prefix.length);
  if (rel.includes("..")) return false;
  if (MCP_WRITE_DENIED.test(rel)) return false;
  if (MCP_WRITE_PLATFORM_PATHS.has(rel)) return true;
  // Proposing "start it when that finishes" on a waiting job starts nothing;
  // the yes stays a person's, in Cobblr.
  if (method === "POST" && /^\/services\/jobs\/[A-Za-z0-9-]+\/trigger$/.test(rel)) return true;
  return /^\/(modules|instances)\/[a-z0-9_-]+\/.+/i.test(rel);
}

/** The ONE write a read grant may do, and it is not a write to the workspace:
 *  appending a step to the chat turn its own user is watching. The relay does
 *  the model's tool calls inside one long request, so without this the panel
 *  learns nothing between "thinking" and "done" — sixty locations appeared in
 *  a workspace over two minutes with the panel showing a spinner (prod,
 *  2026-08-20). The endpoint behind it can only touch the caller's own OPEN
 *  turn and only step-shaped events: no finishing a turn, no failing one, no
 *  words in Cobb's mouth. */
const MCP_NARRATE_PATH = "/modules/core-ai/chat/turns/open/steps";

/** What a View as grant may reach: reads of its one workspace, the account
 *  read the app starts from (answered narrowed, me.ts), and ending itself. */
export function shareViewPathAllowed(method: string, originalUrl: string, slug: string): boolean {
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  if (path.includes("..")) return false;
  if (method === "POST") return path === "/api/v1/share-view/end" || path === "/api/v1/share-view/renew";
  if (method !== "GET" && method !== "HEAD") return false;
  const safe = slug.replace(/[^a-z0-9-]/gi, "");
  if (!safe) return false;
  return path === "/api/v1/me" || path === `/api/v1/orgs/${safe}` || path.startsWith(`/api/v1/orgs/${safe}/`);
}

/** Reads that ask a model unless told `ai=0`: the grant admits them only
 *  with it, so a read token never spends a model call (get_scan_item's
 *  catalog_candidates, #6888). */
const MCP_READS_THAT_COULD_ASK_A_MODEL: RegExp[] = [/^\/modules\/core-scan\/inbox\/[A-Za-z0-9-]+\/catalog-candidates$/];

export function mcpReadPathAllowed(method: string, originalUrl: string, slug: string): boolean {
  if (method === "POST") {
    const safe = slug.replace(/[^a-z0-9-]/gi, "");
    const p = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
    return !!safe && p === `/api/v1/orgs/${safe}${MCP_NARRATE_PATH}`;
  }
  if (method !== "GET") return false;
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, "");
  if (!safeSlug) return false;
  const path = (originalUrl.split("?")[0] ?? "").replace(/\/+$/, "");
  const prefix = `/api/v1/orgs/${safeSlug}`;
  if (!path.startsWith(prefix + "/")) return false; // pinned to THIS workspace
  const rel = path.slice(prefix.length); // e.g. "/entity-kinds", "/entities/<kind>/<id>"
  if (rel.includes("..")) return false;
  if (MCP_READS_THAT_COULD_ASK_A_MODEL.some((p) => p.test(rel))) {
    return new URLSearchParams(originalUrl.split("?")[1] ?? "").get("ai") === "0";
  }
  return MCP_READ_PATHS.some((p) => (typeof p === "string" ? rel === p : p.test(rel)));
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
    let appEditKinds: readonly string[] = [];
    let mcpReadSlug: string | null = null;
    let mcpWriteSlug: string | null = null;
    let shareViewSid: string | null = null;
    let tokenScopes: string[] | null = null;
    let tokenName: string | null = null;
    let tokenGrant: { access: TokenAccess | null; orgId: string | null; orgSlug: string | null; expiresAt: string | null } | null = null;
    let tokenIssuedAt: number | null = null; // JWT iat (seconds), session/app only
    if (token.startsWith("cbt_")) {
      const resolved = await resolveApiToken(token);
      if (resolved) {
        userId = resolved.userId;
        authMethod = "api_token";
        apiTokenId = resolved.tokenId;
        tokenScopes = resolved.scopes;
        tokenName = resolved.name;
        // A connector's access token is for the MCP endpoint (its audience).
        // That endpoint reaches REST through this api with its proxy secret
        // (mcp-proxy.ts); from anywhere else the token is refused, so a token
        // copied out of a connector is not a general API key. A route serving
        // that call reaches the api's own routes in-process with the same
        // token (selfFetch), and those are the same call: refused, an MCP
        // add_thing read no lists and routed a book nowhere (#6037).
        if (resolved.audience && !isMcpProxyCall(req.headers) && !isSelfCall(req)) {
          res.status(401).json({ error: { code: "wrong_audience", message: "This token is for the MCP endpoint only." } });
          return;
        }
        if (resolved.access || resolved.orgId) {
          tokenGrant = { access: resolved.access, orgId: resolved.orgId, orgSlug: resolved.orgSlug, expiresAt: resolved.expiresAt };
        }
      }
    } else {
      const claims = await verifySession(token);
      userId = claims.sub;
      tokenIssuedAt = typeof claims.iat === "number" ? claims.iat : null;
      if (typeof claims.aud === "string" && claims.aud.startsWith("app:")) {
        appScope = claims.aud.slice("app:".length);
        appEditKinds = claims.edits ?? [];
      } else if (typeof claims.aud === "string" && claims.aud.startsWith("mcp-read:")) {
        mcpReadSlug = claims.aud.slice("mcp-read:".length);
      } else if (typeof claims.aud === "string" && claims.aud.startsWith("mcp-write:")) {
        mcpWriteSlug = claims.aud.slice("mcp-write:".length);
      } else if (typeof claims.aud === "string" && claims.aud.startsWith("share-view:")) {
        shareViewSid = claims.aud.slice("share-view:".length);
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
      .select(["id", "email", "display_name", "active", "tokens_valid_from", "must_reset_password", "title_pref"])
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
    // MCP read-grant — DENY-by-default clamp to GET-only workspace reads pinned
    // to its own slug. Blocks writes + other workspaces even though the token
    // carries the member's full identity (see mcpReadPathAllowed).
    if (mcpReadSlug !== null && !mcpReadPathAllowed(req.method, req.originalUrl, mcpReadSlug)) {
      res.status(403).json({
        error: {
          code: "mcp_read_out_of_scope",
          message: "This read-grant may only GET workspace records in its own workspace.",
        },
      });
      return;
    }
    // View as, through a share — GETs in the one share space, until the grant
    // is ended or runs out. Read-only by construction, not by hiding buttons.
    let shareView: SessionUser["share_view"] = null;
    if (shareViewSid !== null) {
      const grant = await meta
        .selectFrom("share_view_sessions as v")
        .innerJoin("orgs as o", "o.id", "v.org_id")
        .innerJoin("share_links as l", "l.id", "v.link_id")
        .select(["v.id", "v.org_id", "o.slug", "v.viewer_name", "v.expires_at", "v.ended_at", "v.target_user_id", "l.status as share_status"])
        .where("v.id", "=", shareViewSid)
        .executeTakeFirst()
        .catch(() => undefined);
      // A share that ended ends its views at once, not when the grant runs out.
      if (!grant || grant.ended_at || grant.expires_at.getTime() <= Date.now() || grant.target_user_id !== userId || grant.share_status !== "active") {
        res.status(401).json({ error: { code: "share_view_ended", message: "This view has ended." } });
        return;
      }
      if (!shareViewPathAllowed(req.method, req.originalUrl, grant.slug)) {
        // Carries `blocked`, so whichever form asked, the app's one refusal
        // sheet says why at once instead of the form failing silently (#4687).
        res.status(403).json({
          error: {
            code: "share_view_read_only",
            message: "Viewing as someone is read-only.",
            blocked: {
              sentence: "This is a read-only preview of what they see, so nothing can be changed here.",
              remedies: [],
              requestable: false,
              reason: "Exit the view to make changes in your own workspace.",
              approvers: { count: 0, names: [] },
              pending: null,
            },
          },
        });
        return;
      }
      shareView = { session_id: grant.id, org_id: grant.org_id, slug: grant.slug, viewer_name: grant.viewer_name, expires_at: grant.expires_at.toISOString() };
      void meta.updateTable("share_view_sessions").set((eb) => ({ request_count: eb("request_count", "+", 1) })).where("id", "=", grant.id).execute().catch(() => undefined);
    }
    // MCP write-grant — record routes in its own workspace, nothing else.
    if (mcpWriteSlug !== null && !mcpWritePathAllowed(req.method, req.originalUrl, mcpWriteSlug)) {
      res.status(403).json({
        error: {
          code: "mcp_write_out_of_scope",
          message: "This write-grant may only read, and create/update/delete records, in its own workspace.",
        },
      });
      return;
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
    // A personal token held to one workspace and an access level (token-access.ts).
    // A token whose workspace was deleted has an org id and no slug: it reaches nothing.
    if (tokenGrant) {
      const verdict = tokenGrant.orgId && !tokenGrant.orgSlug
        ? ({ ok: false, code: "token_workspace_gone", message: "This token's workspace no longer exists." } as const)
        : tokenAccessAllows({ access: tokenGrant.access, orgSlug: tokenGrant.orgSlug }, req.method, req.originalUrl);
      if (!verdict.ok) {
        res.status(403).json({ error: { code: verdict.code, message: verdict.message } });
        return;
      }
    }
    req.session = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      auth_method: authMethod,
      api_token_id: apiTokenId,
      is_platform_admin: isPlatformAdmin(user.email),
      app_scope: appScope,
      app_edit_kinds: appEditKinds,
      token_scopes: tokenScopes,
      token_access: tokenGrant?.access ?? null,
      token_org_id: tokenGrant?.orgId ?? null,
      token_expires_at: tokenGrant?.expiresAt ?? null,
      must_reset_password: user.must_reset_password,
      issued_at: tokenIssuedAt,
      // How a titled work's title reads for this person: served rows are
      // composed with it (core-scan's withTitle), so every surface shows the
      // one format without each reading the account (#3061).
      title_pref: user.title_pref ?? null,
      share_view: shareView,
      ai_door:
        mcpReadSlug !== null || mcpWriteSlug !== null
          ? "relay"
          : isMcpProxyCall(req.headers) ||
              (authMethod === "api_token" && String(req.headers["x-cobblr-client"] ?? "").toLowerCase() === "mcp")
            ? "mcp"
            : null,
    };
    // Wrap the rest of the request chain in actor context so any
    // deeply-nested activity.log() call automatically picks up
    // user id + auth method + token id.
    // HOW this request acts, for the activity row (#3833): the in-app
    // assistant (a grant with an mcp-read / mcp-write audience) or an
    // assistant over MCP (the MCP server says so on every call it makes with
    // the member's API token). A token call without the header stays "via
    // <token>", which the token's own name already describes.
    //
    // The in-app chat calls on the person's own session and says so with
    // x-cobblr-client: cobb on the calls that start service jobs, so the job
    // is stamped as Cobb's and follows Cobb's consent. A person could send the
    // header themselves, and it would only make their own request ask more:
    // the Cobb door never runs anything the person door would not.
    const client = String(req.headers["x-cobblr-client"] ?? "").toLowerCase();
    // A station's tablet (#4640) acts as the person who approved it, and its
    // rows say which station: "via Pantry station".
    const via: Via | null =
      mcpWriteSlug || mcpReadSlug || client === "cobb"
        ? { kind: "assistant" }
        : authMethod === "api_token" && client === "mcp"
          ? { kind: "mcp" }
          : tokenScopes?.some((k) => isStationScope(k) || isStationQrScope(k))
            ? { kind: "surface", label: tokenName }
            : null;
    const assistant = req.session.ai_door ?? (via?.kind === "assistant" || via?.kind === "mcp" ? via.kind : null) ?? selfCallAssistant(req);
    runWithActor(
      { userId: user.id, authMethod, apiTokenId, titlePref: user.title_pref ?? null, linkOrigin: linkOrigin(req), assistant },
      () => (via ? runVia(via, () => next()) : next()),
    );
  } catch (err) {
    // A token that does not verify is 401. A lookup that could not run is
    // not: when the meta pool had nothing to give, this answered 401
    // "timeout exceeded when trying to connect" and a starving api read as
    // every session expiring at once (#3033). That is a 503, counted as an
    // error and named in the log, never a logout.
    if (err instanceof joseErrors.JOSEError || err instanceof TokenRefused) {
      res.status(401).json({
        error: { code: "unauthenticated", message: err.message },
      });
      return;
    }
    console.error("[auth] the session could not be checked:", (err as Error).message);
    res.status(503).json({
      error: { code: "auth_unavailable", message: "Could not check your session right now; try again in a moment." },
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
