// Google OAuth for a mailbox connection: the consent round trip, the token
// refresh a sync mints its hour of access from, and the revoke a Disconnect
// sends so a grant is ended at Google and not merely forgotten here.
//
// The shape is discord-oauth.ts's: a signed, ten-minute state token binding
// the round trip to one user (and here, to the workspace the mailbox will
// feed), env-gated so a self-host without a Google client lists nothing.
//
// Scope is gmail.readonly and only that. Google classes every scope that
// reads mail as restricted, so read-only costs the same review as anything
// wider and buys the guarantee that matters: this token cannot label,
// archive or send, whatever the code does.
//
// PKCE rides along. The verifier has to survive the redirect without living
// in process memory (the api is stateless), so it travels inside the state
// token ENCRYPTED under the credentials key: the state is signed against
// tampering and the verifier inside it is opaque to anyone who sees the URL.
//
// `||` not `??` for env defaults (CLAUDE.md §14.6); the API bases are
// overridable so a test can stand up a fake Google on localhost.

import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../../env.js";
import { decryptCreds, encryptCreds } from "../../db/crypto.js";
import { publicBaseUrl } from "../public-url.js";
import { MailSourceGrantError } from "./types.js";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
export const GMAIL_CALLBACK_PATH = "/api/v1/me/mail-sources/gmail/callback";
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || (publicBaseUrl() ? `${publicBaseUrl()}${GMAIL_CALLBACK_PATH}` : "");

export const GOOGLE_AUTH_BASE = process.env.COBBLR_GOOGLE_AUTH_BASE || "https://accounts.google.com";
export const GOOGLE_OAUTH_BASE = process.env.COBBLR_GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const STATE_ALG = "HS256";
const STATE_AUD = "gmail-oauth";
const STATE_TTL_SECONDS = 10 * 60;

export function googleOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

/** The redirect Google must have registered; shown on the card and in the
 *  self-host recipe so the one value that has to match is never guessed. */
export function googleRedirectUri(): string {
  return REDIRECT_URI;
}

export interface OAuthStart {
  state: string;
  url: string;
}

/** Sign the state and build the consent URL. The verifier is minted here and
 *  lives only inside the state, encrypted. */
export async function beginGoogleConsent(userId: string, orgId: string): Promise<OAuthStart> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const now = Math.floor(Date.now() / 1000);
  const state = await new SignJWT({ org: orgId, v: encryptCreds(verifier) })
    .setProtectedHeader({ alg: STATE_ALG })
    .setIssuer("cobblr")
    .setAudience(STATE_AUD)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    // A refresh token is only issued on a CONSENTED grant; a silent re-auth
    // returns none, and a mailbox with no refresh token stops in an hour.
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { state, url: `${GOOGLE_AUTH_BASE}/o/oauth2/v2/auth?${p.toString()}` };
}

export interface OAuthStateClaims {
  userId: string;
  orgId: string;
  verifier: string;
}

/** Verify the state on the way back; null for anything not ours or expired. */
export async function readGoogleState(state: string): Promise<OAuthStateClaims | null> {
  try {
    const { payload } = await jwtVerify(state, new TextEncoder().encode(env.JWT_SECRET), {
      issuer: "cobblr",
      audience: STATE_AUD,
      algorithms: [STATE_ALG],
    });
    if (typeof payload.sub !== "string" || typeof payload.org !== "string" || typeof payload.v !== "string") return null;
    return { userId: payload.sub, orgId: payload.org, verifier: decryptCreds(payload.v) };
  } catch {
    return null;
  }
}

export interface GoogleGrant {
  refresh_token: string;
  access_token: string;
  expires_in: number;
}

/** The code for the tokens. Null on any failure; the callback surfaces a
 *  plain error and the person tries again. */
export async function exchangeGoogleCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<GoogleGrant | null> {
  try {
    const r = await fetchImpl(`${GOOGLE_OAUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    if (!r.ok) return null;
    const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t.access_token || !t.refresh_token) return null;
    return { refresh_token: t.refresh_token, access_token: t.access_token, expires_in: t.expires_in ?? 3600 };
  } catch {
    return null;
  }
}

/** An hour of access from the refresh token. Throws MailSourceGrantError when
 *  Google says the grant is gone (revoked, password changed, the unverified
 *  app's grace ended): that is the person's to fix, not the next round's. */
export async function refreshGoogleAccess(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await fetchImpl(`${GOOGLE_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const t = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (r.status === 400 || r.status === 401) {
    if (t.error === "invalid_grant" || t.error === "invalid_client" || t.error === "unauthorized_client") {
      throw new MailSourceGrantError(t.error_description || t.error);
    }
  }
  if (!r.ok || !t.access_token) throw new Error(`token refresh failed: HTTP ${r.status}${t.error ? ` ${t.error}` : ""}`);
  return t.access_token;
}

/** End the grant at Google. Best effort: a revoke that cannot reach Google is
 *  logged by the caller and the local secret is deleted regardless. */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${GOOGLE_OAUTH_BASE}/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    return r.ok;
  } catch {
    return false;
  }
}
