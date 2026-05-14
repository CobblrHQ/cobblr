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
