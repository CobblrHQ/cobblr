// JWT helpers via jose. We use HS256 with the JWT_SECRET — the same
// process signs and verifies, so symmetric is fine. For future
// stateless multi-instance, we'd switch to a JWKS-backed RSA key.
//
// Payload is intentionally small: subject (user id) + a server-side
// version we can rev to invalidate everything at once (e.g. on a
// password reset). User profile + memberships are looked up fresh per
// request from cobblr_meta — we don't trust stale data in the token.

import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

const ALG = "HS256";
const ISSUER = "cobblr";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export interface SessionClaims {
  sub: string;       // user id
  iat: number;
  exp: number;
  /** Audience. For a capability-scoped app token (H1 Tier B) this is
   *  `app:<slug>`; for a normal session it's undefined. Used by
   *  requireAuth to clamp app tokens to the Tier-B allowlist server-side
   *  (defense-in-depth — not just the client-side mediator). */
  aud?: string;
}

export async function signSession(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + env.SESSION_TTL_DAYS * 24 * 60 * 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey());
}

// Capability-scoped app token (H1 Tier B). A SHORT-LIVED token carrying
// the member's own identity (sub = userId) + an `app:<slug>` audience.
// It verifies as a normal session (verifySession ignores aud), so every
// call it makes runs as the member — bounded by their capabilities +
// field-read-scope (H2). It can NEVER exceed the member; the short TTL
// and audience just limit blast radius + make it auditable. Minted for
// a sandboxed custom-app frontend to read through (mediated by the App
// Player), never the long-lived session.
const APP_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

export async function signAppToken(
  userId: string,
  appSlug: string,
): Promise<{ token: string; expires_in: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + APP_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setAudience(`app:${appSlug}`)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey());
  return { token, expires_in: APP_TOKEN_TTL_SECONDS };
}

// MCP read-grant (Ask Cobb over the subscription bridge). A SHORT-LIVED token
// carrying the member's own identity (sub = userId) + an `mcp-read:<slug>`
// audience. It verifies as a normal session (verifySession ignores aud), so
// every call runs AS the member — bounded by their capabilities + field-read
// scope. requireAuth clamps it HARD to GET-only workspace reads pinned to
// <slug> (mcpReadPathAllowed), so a write (POST /actions/invoke) or a different
// workspace is 403 even though the token carries the member's full identity.
// Minted per chat turn by core-ai when the workspace's chat provider is a
// Claude-subscription bridge, and handed to that bridge so `claude -p` can read
// the workspace over MCP. See docs/design-decisions/ask-cobb-bridge-mcp-tools.md.
const MCP_READ_TTL_SECONDS = 15 * 60; // 15 minutes — one chat turn's worth

export async function signMcpReadGrant(userId: string, orgSlug: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setAudience(`mcp-read:${orgSlug}`)
    .setIssuedAt(now)
    .setExpirationTime(now + MCP_READ_TTL_SECONDS)
    .sign(secretKey());
}

// MCP WRITE grant — the record-CRUD counterpart, and deliberately NOT the token
// the bridge holds. The relay hands `claude -p` a READ grant; when a tool call
// comes back asking to create/update/delete a record, the hosted MCP endpoint
// checks the user's own chat consent (write_mode: auto) and only then mints one
// of these, in-process, for that single call. It never crosses the wire to the
// bridge, which is why a longer reach is acceptable here and would not be on
// the relayed token.
//
// Clamped by mcpWritePathAllowed to record routes (/modules/<m>/… and
// /instances/<i>/…) — the shapes the entity-kind registry resolves writes to.
// Actions (/actions/invoke) are NOT reachable: they are irreversible and the
// consent model says they always confirm, and a relayed chat has no way to ask.
const MCP_WRITE_TTL_SECONDS = 60; // one tool call's worth

export async function signMcpWriteGrant(userId: string, orgSlug: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setAudience(`mcp-write:${orgSlug}`)
    .setIssuedAt(now)
    .setExpirationTime(now + MCP_WRITE_TTL_SECONDS)
    .sign(secretKey());
}

// Operator impersonation ("View as"). A SHORT-LIVED token distinct from a
// session: it carries BOTH identities — `sub` is the operator (never replaced,
// so attribution can't be forged), `act` the target member, `org` the scope,
// `sid` the server-side session row it points at. Sent in the `X-Impersonation`
// header alongside the operator's real Bearer session; verified + matched in
// withTenant. See docs/modules/operator-impersonation.md.
export interface ImpersonationClaims {
  typ: "impersonation";
  sub: string; // operator user id
  act: string; // target user id
  org: string; // org id
  sid: string; // impersonation_sessions.id
  iat: number;
  exp: number;
}

export async function signImpersonation(
  operatorId: string,
  targetId: string,
  orgId: string,
  sessionId: string,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "impersonation", act: targetId, org: orgId, sid: sessionId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(operatorId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey());
}

export async function verifyImpersonation(token: string): Promise<ImpersonationClaims> {
  const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, algorithms: [ALG] });
  if (payload.typ !== "impersonation") throw new Error("Not an impersonation token");
  const { sub, act, org, sid } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof act !== "string" || typeof org !== "string" || typeof sid !== "string") {
    throw new Error("Invalid impersonation token claims");
  }
  return { typ: "impersonation", sub, act, org, sid, iat: payload.iat as number, exp: payload.exp as number };
}

export async function verifySession(token: string): Promise<SessionClaims> {
  // Pin the algorithm allowlist explicitly — don't rely solely on the
  // symmetric key type to reject RS256/none confusion.
  const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, algorithms: [ALG] });
  if (typeof payload.sub !== "string") {
    throw new Error("Invalid token: missing sub");
  }
  // An impersonation token must NEVER authenticate as a full session — it's a
  // scoped grant carried in X-Impersonation, not a login. Reject it as Bearer.
  if (payload.typ === "impersonation") {
    throw new Error("Impersonation token cannot be used as a session");
  }
  return {
    sub: payload.sub,
    iat: payload.iat as number,
    exp: payload.exp as number,
    aud: typeof payload.aud === "string" ? payload.aud : Array.isArray(payload.aud) ? payload.aud[0] : undefined,
  };
}
