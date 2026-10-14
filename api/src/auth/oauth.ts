// Sign in to Cobblr from an AI assistant's connector (#3803).
//
// claude.ai and the Claude phone apps cannot send a token header: a custom
// connector takes a URL and signs in with OAuth, per the MCP authorization
// spec. This deployment is its own authorization server for its own MCP
// endpoint, so a self-hosted instance needs no outside service:
//
//   1. the MCP endpoint answers 401 with `WWW-Authenticate: Bearer
//      resource_metadata=…` (hosted-mcp.ts);
//   2. protected-resource metadata (RFC 9728) names this origin as the
//      authorization server; its metadata (RFC 8414) names the endpoints;
//   3. the connector registers itself (RFC 7591), only with a redirect this
//      deployment allows;
//   4. the person signs in the usual way and approves on /oauth/authorize,
//      choosing ONE workspace and Look only or Look and make changes;
//   5. the code (single-use, a minute, PKCE S256, bound to the client,
//      redirect and resource) becomes an access token and a refresh token.
//
// The access token is an ordinary api_tokens row held to that workspace and
// access level (token-access.ts), so every clamp a personal token has applies
// unchanged, and it reaches REST only through the MCP endpoint (its audience):
// requireAuth refuses it from anywhere but this api's own loopback proxy.
// Refresh tokens rotate; a spent one presented again revokes the connection.

import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { meta } from "../db/meta.js";
import { requireAuth } from "./middleware.js";
import { hashToken, mintTokenString } from "./api-tokens.js";
import { IP_LIMITS_OFF } from "../platform/ip-limiter.js";

export const MCP_PATH = "/api/v1/hooks/mcp";
export const OAUTH_SCOPES = ["cobblr:look", "cobblr:change"] as const;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

/** Redirects a connector may register. Exact match only. Loopback (any port)
 *  for desktop clients (RFC 8252). More by env on a self-hosted instance. */
const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

export function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) return true;
  const extra = (process.env.COBBLR_OAUTH_REDIRECT_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_REDIRECTS, ...extra].includes(uri);
}


/** This deployment's public origin, as the connector reaches it. */
export function originOf(req: { protocol?: string; get?(name: string): string | undefined; headers?: Record<string, string | string[] | undefined> }): string {
  const configured = publicBaseUrl();
  if (configured) return configured;
  const h = (name: string) => {
    const v = req.get ? req.get(name) : req.headers?.[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const proto = (h("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "https").replace(/:$/, "");
  return `${proto}://${h("x-forwarded-host") || h("host")}`;
}

export const resourceUrl = (origin: string) => `${origin}${MCP_PATH}`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

const sha256b64url = (s: string) => createHash("sha256").update(s).digest("base64url");
const opaque = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

function makeLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    return true;
  };
}
const LIMITS_OFF = IP_LIMITS_OFF;
const registerLimiter = makeLimiter(60_000, 20);
const tokenLimiter = makeLimiter(60_000, 60);
const over = (l: (k: string) => boolean, req: Request) => !LIMITS_OFF && !l(req.ip ?? "unknown");

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

// ── discovery (mounted at the site root, see server.ts) ─────────────────────
export const wellKnownRouter = Router();

function protectedResource(req: Request, res: Response) {
  const origin = originOf(req);
  res.json({
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Cobblr",
  });
}
wellKnownRouter.get("/.well-known/oauth-protected-resource", protectedResource);
wellKnownRouter.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResource);

wellKnownRouter.get("/.well-known/oauth-authorization-server", (req, res) => {
  const origin = originOf(req);
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/v1/oauth/token`,
    registration_endpoint: `${origin}/api/v1/oauth/register`,
    revocation_endpoint: `${origin}/api/v1/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: OAUTH_SCOPES,
  });
});

// ── the flow (mounted under /api/v1) ────────────────────────────────────────
export const oauthRouter = Router();

// Whether a connector can be pointed at a workspace, and where. A try-it
// sandbox cannot: it lasts an hour and has no account behind it. That is a
// fact about the WORKSPACE, so it is asked per workspace; a server that
// hands out sandboxes also holds kept trials, which are real accounts.
oauthRouter.get("/oauth/status", async (req, res, next) => {
  try {
    const slug = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const org = slug ? await meta.selectFrom("orgs").select("sandbox").where("slug", "=", slug).executeTakeFirst() : undefined;
    res.json({ available: !org?.sandbox, mcp_url: resourceUrl(originOf(req)) });
  } catch (err) {
    next(err);
  }
});

const RegisterBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(500)).min(1).max(10),
  client_name: z.string().max(120).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

// AI-REACH: exempt — the OAuth handshake a connector performs, not a workspace action.
oauthRouter.post("/oauth/register", async (req, res, next) => {
  try {
    if (over(registerLimiter, req)) return void oauthError(res, 429, "slow_down", "Too many registrations; wait a minute.");
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return void oauthError(res, 400, "invalid_client_metadata", "redirect_uris is required.");
    const bad = parsed.data.redirect_uris.filter((u) => !redirectAllowed(u));
    if (bad.length) return void oauthError(res, 400, "invalid_redirect_uri", `Not an allowed redirect: ${bad.join(", ")}`);
    if (parsed.data.token_endpoint_auth_method && parsed.data.token_endpoint_auth_method !== "none") {
      return void oauthError(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method none, with PKCE).");
    }
    const clientId = opaque("cbc_");
    await meta
      .insertInto("oauth_clients")
      .values({ client_id: clientId, client_name: parsed.data.client_name?.trim() || null, redirect_uris: parsed.data.redirect_uris })
      .execute();
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: parsed.data.client_name ?? null,
      redirect_uris: parsed.data.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  } catch (err) {
    next(err);
  }
});

const AuthorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});

/** Everything the consent screen may trust, checked BEFORE it is shown: a
 *  request this refuses never reaches a redirect, so a bad redirect_uri
 *  cannot receive even an error. */
async function checkAuthorize(req: Request, q: unknown) {
  const parsed = AuthorizeQuery.safeParse(q);
  if (!parsed.success) return { ok: false as const, error: "The connector sent an incomplete sign-in request (it needs a PKCE S256 challenge)." };
  const client = await meta.selectFrom("oauth_clients").selectAll().where("client_id", "=", parsed.data.client_id).executeTakeFirst();
  if (!client) return { ok: false as const, error: "This connector is not registered here." };
  if (!client.redirect_uris.includes(parsed.data.redirect_uri) || !redirectAllowed(parsed.data.redirect_uri)) {
    return { ok: false as const, error: "This connector asked to send you somewhere it did not register." };
  }
  const expected = resourceUrl(originOf(req));
  if (parsed.data.resource && parsed.data.resource !== expected) {
    return { ok: false as const, error: "This connector asked for access to a different server." };
  }
  return { ok: true as const, q: parsed.data, client, resource: expected };
}

const sessionOnly = (req: Request) => req.session?.auth_method === "session";

oauthRouter.get("/oauth/authorize/check", requireAuth, async (req, res, next) => {
  try {
    if (!sessionOnly(req)) return void res.status(403).json({ error: { code: "session_required", message: "Sign in to approve a connector." } });
    const c = await checkAuthorize(req, req.query);
    if (!c.ok) return void res.status(400).json({ error: { code: "invalid_request", message: c.error } });
    const workspaces = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select(["o.id", "o.name", "o.slug"])
      .where("m.user_id", "=", req.session!.id)
      .where("o.sandbox", "=", false)
      .orderBy("o.created_at")
      .execute();
    res.json({
      client_name: c.client.client_name,
      redirect_host: new URL(c.q.redirect_uri).host,
      wants_changes: (c.q.scope ?? "").includes("cobblr:change"),
      workspaces,
    });
  } catch (err) {
    next(err);
  }
});

const ApproveBody = AuthorizeQuery.extend({
  decision: z.enum(["allow", "deny"]),
  workspace: z.string().min(1).optional(),
  access: z.enum(["look", "change"]).optional(),
});

// AI-REACH: exempt — a person approving a connector on the consent screen, not a workspace action.
oauthRouter.post("/oauth/authorize", requireAuth, async (req, res, next) => {
  try {
    // A token cannot approve a connector: only the person, signed in.
    if (!sessionOnly(req)) return void res.status(403).json({ error: { code: "session_required", message: "Sign in to approve a connector." } });
    const body = ApproveBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_request", message: "Bad approval." } });
    const c = await checkAuthorize(req, body.data);
    if (!c.ok) return void res.status(400).json({ error: { code: "invalid_request", message: c.error } });
    const back = new URL(c.q.redirect_uri);
    if (c.q.state) back.searchParams.set("state", c.q.state);
    back.searchParams.set("iss", originOf(req));
    if (body.data.decision === "deny") {
      back.searchParams.set("error", "access_denied");
      return void res.json({ redirect: back.toString() });
    }
    const w = body.data.workspace ?? "";
    const org = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("o.id")
      .where("m.user_id", "=", req.session!.id)
      .where("o.sandbox", "=", false)
      .where((eb) => (/^[0-9a-f-]{36}$/i.test(w) ? eb("o.id", "=", w) : eb("o.slug", "=", w)))
      .executeTakeFirst();
    if (!org) return void res.status(400).json({ error: { code: "unknown_workspace", message: "Pick a workspace you belong to. A try-it sandbox cannot be connected: keep it first." } });
    const code = opaque("cbo_");
    await meta
      .insertInto("oauth_codes")
      .values({
        code_hash: hashToken(code),
        client_id: c.q.client_id,
        user_id: req.session!.id,
        org_id: org.id,
        access: body.data.access ?? "look",
        redirect_uri: c.q.redirect_uri,
        code_challenge: c.q.code_challenge,
        resource: c.resource,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      })
      .execute();
    back.searchParams.set("code", code);
    res.json({ redirect: back.toString() });
  } catch (err) {
    next(err);
  }
});

/** A fresh access token (an hour) and refresh token for a grant. The access
 *  token is an api_tokens row held to the grant's workspace and access. */
async function issue(grant: { id: string; user_id: string; org_id: string; access: string; resource: string; client_id: string }) {
  const client = await meta.selectFrom("oauth_clients").select("client_name").where("client_id", "=", grant.client_id).executeTakeFirst();
  // One live access token per connection: the one being replaced goes now.
  await meta.updateTable("api_tokens").set({ revoked_at: new Date() }).where("grant_id", "=", grant.id).where("revoked_at", "is", null).execute();
  const { plaintext, hash, tokenPrefix } = mintTokenString();
  await meta
    .insertInto("api_tokens")
    .values({
      user_id: grant.user_id,
      name: `${client?.client_name || "AI assistant"} (connector)`,
      token_hash: hash,
      token_prefix: tokenPrefix,
      expires_at: new Date(Date.now() + ACCESS_TTL_S * 1000),
      scopes: null,
      source: "oauth",
      meta: JSON.stringify({ resource: grant.resource, client_id: grant.client_id }),
      org_id: grant.org_id,
      access: grant.access,
      grant_id: grant.id,
    })
    .execute();
  const refresh = opaque("cbr_");
  await meta
    .insertInto("oauth_refresh_tokens")
    .values({ token_hash: hashToken(refresh), grant_id: grant.id, expires_at: new Date(Date.now() + REFRESH_TTL_MS) })
    .execute();
  return {
    access_token: plaintext,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: grant.access === "change" ? "cobblr:look cobblr:change" : "cobblr:look",
  };
}

/** Disconnect: the grant, every access token and refresh token it issued. */
export async function revokeGrant(grantId: string): Promise<void> {
  const now = new Date();
  await meta.updateTable("oauth_grants").set({ revoked_at: now }).where("id", "=", grantId).where("revoked_at", "is", null).execute();
  await meta.updateTable("api_tokens").set({ revoked_at: now }).where("grant_id", "=", grantId).where("revoked_at", "is", null).execute();
  await meta.updateTable("oauth_refresh_tokens").set({ used_at: now }).where("grant_id", "=", grantId).where("used_at", "is", null).execute();
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// AI-REACH: exempt — the OAuth token endpoint a connector calls, not a workspace action.
oauthRouter.post("/oauth/token", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (over(tokenLimiter, req)) return void oauthError(res, 429, "slow_down", "Too many requests; wait a minute.");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const grantType = str(b.grant_type);
    const clientId = str(b.client_id);

    if (grantType === "authorization_code") {
      const code = str(b.code);
      const row = code
        ? await meta.selectFrom("oauth_codes").selectAll().where("code_hash", "=", hashToken(code)).executeTakeFirst()
        : undefined;
      if (!row || row.used_at || row.expires_at < new Date()) return void oauthError(res, 400, "invalid_grant", "The code is unknown, used or expired.");
      // Spend it first: a code is single-use even when what follows fails.
      const spent = await meta
        .updateTable("oauth_codes")
        .set({ used_at: new Date() })
        .where("code_hash", "=", row.code_hash)
        .where("used_at", "is", null)
        .returning("code_hash")
        .executeTakeFirst();
      if (!spent) return void oauthError(res, 400, "invalid_grant", "The code was already used.");
      if (clientId && clientId !== row.client_id) return void oauthError(res, 400, "invalid_grant", "The code was issued to another client.");
      if (str(b.redirect_uri) !== row.redirect_uri) return void oauthError(res, 400, "invalid_grant", "redirect_uri does not match the one the code was issued for.");
      const verifier = str(b.code_verifier);
      if (!verifier || sha256b64url(verifier) !== row.code_challenge) return void oauthError(res, 400, "invalid_grant", "The code verifier does not match.");
      if (str(b.resource) && str(b.resource) !== row.resource) return void oauthError(res, 400, "invalid_target", "The code was issued for a different resource.");
      const grant = await meta
        .insertInto("oauth_grants")
        .values({ client_id: row.client_id, user_id: row.user_id, org_id: row.org_id, access: row.access, resource: row.resource })
        .returningAll()
        .executeTakeFirstOrThrow();
      return void res.json(await issue(grant));
    }

    if (grantType === "refresh_token") {
      const presented = str(b.refresh_token);
      const row = presented
        ? await meta.selectFrom("oauth_refresh_tokens").selectAll().where("token_hash", "=", hashToken(presented)).executeTakeFirst()
        : undefined;
      if (!row) return void oauthError(res, 400, "invalid_grant", "Unknown refresh token.");
      const grant = await meta.selectFrom("oauth_grants").selectAll().where("id", "=", row.grant_id).executeTakeFirst();
      if (!grant || grant.revoked_at) return void oauthError(res, 400, "invalid_grant", "This connection was disconnected.");
      if (clientId && clientId !== grant.client_id) return void oauthError(res, 400, "invalid_grant", "The refresh token belongs to another client.");
      // A spent refresh token presented again was copied: disconnect.
      if (row.used_at) {
        await revokeGrant(grant.id);
        return void oauthError(res, 400, "invalid_grant", "This refresh token was already used; the connection has been disconnected.");
      }
      if (row.expires_at < new Date()) return void oauthError(res, 400, "invalid_grant", "The refresh token expired; connect again.");
      await meta.updateTable("oauth_refresh_tokens").set({ used_at: new Date() }).where("token_hash", "=", row.token_hash).execute();
      return void res.json(await issue(grant));
    }

    oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — RFC 7009 revocation a connector calls, not a workspace action.
oauthRouter.post("/oauth/revoke", async (req, res, next) => {
  try {
    const token = str((req.body ?? {}).token);
    if (token) {
      const refresh = await meta.selectFrom("oauth_refresh_tokens").select("grant_id").where("token_hash", "=", hashToken(token)).executeTakeFirst();
      const access = refresh
        ? undefined
        : await meta.selectFrom("api_tokens").select("grant_id").where("token_hash", "=", hashToken(token)).executeTakeFirst();
      const grantId = refresh?.grant_id ?? access?.grant_id;
      if (grantId) await revokeGrant(grantId);
    }
    // RFC 7009: the same answer whether or not the token was known.
    res.status(200).json({});
  } catch (err) {
    next(err);
  }
});

// ── the person's own connections (the Connect page) ─────────────────────────
oauthRouter.get("/me/oauth-grants", requireAuth, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("oauth_grants as g")
      .innerJoin("oauth_clients as c", "c.client_id", "g.client_id")
      .innerJoin("orgs as o", "o.id", "g.org_id")
      .select([
        "g.id as id", "c.client_name as client_name", "c.redirect_uris as redirect_uris", "g.access as access",
        "o.name as org_name", "o.slug as org_slug", "g.created_at as created_at", "g.last_used_at as last_used_at",
      ])
      .where("g.user_id", "=", req.session!.id)
      .where("g.revoked_at", "is", null)
      .orderBy("g.created_at", "desc")
      .execute();
    res.json({
      items: rows.map(({ redirect_uris, ...r }) => ({ ...r, redirect_host: redirect_uris[0] ? new URL(redirect_uris[0]).host : null })),
    });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — disconnecting your own AI connector is a person's account setting.
oauthRouter.delete("/me/oauth-grants/:id", requireAuth, async (req, res, next) => {
  try {
    const own = await meta
      .selectFrom("oauth_grants")
      .select("id")
      .where("id", "=", req.params.id!)
      .where("user_id", "=", req.session!.id)
      .executeTakeFirst();
    if (!own) return void res.status(404).json({ error: { code: "not_found", message: "No such connection." } });
    await revokeGrant(own.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
