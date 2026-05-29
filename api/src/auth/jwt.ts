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

export async function verifySession(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER });
  if (typeof payload.sub !== "string") {
    throw new Error("Invalid token: missing sub");
  }
  return {
    sub: payload.sub,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}
