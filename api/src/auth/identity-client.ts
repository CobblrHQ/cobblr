// Central identity federation client (Slice 3). This surface is a CLIENT of the
// central Cobblr identity service (CobblrHQ/identity): it verifies identity tokens
// against the service's published JWKS and links its local users to global identities.
//
// Everything here is a NO-OP unless IDENTITY_URL is set — a surface with no central
// identity configured owns its own accounts exactly as before. Verifying against a
// JWKS (not a shared secret) is the portability keystone: rotating keys or moving the
// identity host republishes the JWKS; this surface needs no redeploy.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../env.js";

export function identityEnabled(): boolean {
  return !!env.IDENTITY_URL;
}

/** The rule, as a pure function so a test can reach it. Importing this module runs env,
 *  which process.exit(1)s without database vars, so anything worth asserting has to be
 *  callable without touching env — the same reason announce-url.ts is its own file. */
export function callbackEnabledFrom(url?: string, secret?: string): boolean {
  return !!url && !!secret;
}

/** The browser hand-off needs BOTH a service to talk to and this surface's own secret to
 *  redeem with. Half-configured is off: a callback route that accepted codes it could not
 *  redeem would fail per-user, at sign-in, which is the worst place to discover it. */
export function identityCallbackEnabled(): boolean {
  return callbackEnabledFrom(env.IDENTITY_URL, env.IDENTITY_DEPLOYMENT_SECRET);
}

/** Does this surface hand a workspace to an account that arrives without one?
 *  Off unless explicitly set: a private surface turning strangers away is the correct
 *  behaviour, and getting this backwards on one is a public signup nobody opened. */
export function autoProvisionEnabled(): boolean {
  return env.COBBLR_IDENTITY_AUTOPROVISION === "true";
}

/** This surface's stable id in the identity map (deployment_links). */
export function deploymentId(): string {
  return env.COBBLR_DEPLOYMENT || env.COBBLR_ENV || "default";
}

function base(): string {
  return (env.IDENTITY_URL ?? "").replace(/\/+$/, "");
}

/** The identity service as a BROWSER must reach it, which is not always how the API
 *  reaches it. `base()` is the server-to-server hop and may legitimately be a LAN
 *  address; this one is handed out as a redirect target, so it has to resolve for a
 *  stranger on the internet. Falls back to IDENTITY_URL, which is correct for the
 *  single-URL case (self-host, dev) and is why the two were conflated to begin with. */
export function browserBase(): string {
  return ((env.IDENTITY_PUBLIC_URL || env.IDENTITY_URL) ?? "").replace(/\/+$/, "");
}

// Private / loopback / CGNAT-tailnet hosts — plain http to these is a trusted LAN hop, not
// a cleartext-over-the-internet leak. (RFC1918 + loopback + Tailscale 100.64/10.)
const PRIVATE_HOST = /^(localhost|127\.|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** True when IDENTITY_URL is plain http to a NON-private host — backfill would push user
 *  email + bcrypt hashes over cleartext to the public internet. https or a private/LAN
 *  address is fine. Pure. */
export function isInsecureIdentityUrl(url = env.IDENTITY_URL ?? ""): boolean {
  if (!url.startsWith("http://")) return false; // https, or unset
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return !PRIVATE_HOST.test(host);
}

/** True when the URL handed to BROWSERS points at a private/loopback/CGNAT host, which
 *  no outside visitor can resolve. The mirror image of isInsecureIdentityUrl: there a
 *  private host is FINE (a trusted LAN hop for server-to-server backfill), here it is the
 *  whole defect. try.cobblr.xyz shipped `http://192.168.1.138:8790/authorize` as its
 *  public authorize_url, so every visitor who clicked "Continue with your Cobblr account"
 *  was redirected into a dead end. Pure. */
export function isUnreachableBrowserUrl(url = browserBase()): boolean {
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return PRIVATE_HOST.test(host);
}

/** Log the federation config once at boot. A wrong IDENTITY_ISSUER/AUDIENCE makes EVERY
 *  exchange 401 indistinguishably from a bad token ("SSO just doesn't work"), so surface
 *  exactly what this surface is configured to verify + where. No-op unless enabled. */
export function logIdentityConfig(): void {
  if (!identityEnabled()) return;
  console.log(
    `[identity] federation ON — url=${base()} deployment=${deploymentId()} ` +
      `issuer=${env.IDENTITY_ISSUER} audience=${env.IDENTITY_AUDIENCE} jwks=${base()}/.well-known/jwks.json`,
  );
  // Loud, because the symptom appears on somebody else's site after a redirect, where
  // nothing here can explain it, and the surface itself looks perfectly healthy.
  if (identityCallbackEnabled() && isUnreachableBrowserUrl()) {
    console.warn(
      `[identity] WARNING: the sign-in button sends browsers to ${browserBase()}, a private ` +
        "address no visitor can reach. Set IDENTITY_PUBLIC_URL to the account service's " +
        "public https URL (IDENTITY_URL stays as the server-to-server hop).",
    );
  }
  if (isInsecureIdentityUrl()) {
    console.warn(
      "[identity] WARNING: IDENTITY_URL is plain http to a public host — user email + bcrypt " +
        "hashes cross the wire in cleartext during backfill. Use https or a private/LAN address.",
    );
  }
}

let _jwks: JWTVerifyGetKey | null = null;
function remoteJwks(): JWTVerifyGetKey {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(base() + "/.well-known/jwks.json"));
  return _jwks;
}

/** Verify a central identity token → its global identity id (`sub`). Throws on any
 *  invalid/expired/wrong-issuer token. */
export async function verifyIdentityToken(token: string): Promise<string> {
  return verifyIdentityTokenWith(token, remoteJwks());
}

/** The testable core of verifyIdentityToken — the key set is injected so a unit test
 *  can pass a local JWKS built from a generated keypair (no network). */
export async function verifyIdentityTokenWith(token: string, keySet: JWTVerifyGetKey): Promise<string> {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: env.IDENTITY_ISSUER,
    audience: env.IDENTITY_AUDIENCE,
  });
  if (!payload.sub) throw new Error("identity token missing sub");
  return payload.sub;
}

export interface BackfillUser {
  local_user_id: string;
  email: string;
  password_hash?: string | null;
  display_name?: string | null;
}

/** The request body the identity /admin/backfill endpoint expects (pure — testable). */
export function buildBackfillBody(deployment: string, users: BackfillUser[]) {
  return { deployment, users };
}

/** POST a batch of local users to the identity service; returns { local_user_id:
 *  identity_id }. Throws if identity isn't fully configured or the call fails. */
export async function backfillToIdentity(users: BackfillUser[]): Promise<Record<string, string>> {
  if (!env.IDENTITY_URL || !env.IDENTITY_ADMIN_TOKEN) {
    throw new Error("identity backfill not configured (need IDENTITY_URL + IDENTITY_ADMIN_TOKEN)");
  }
  const res = await fetch(base() + "/admin/backfill", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.IDENTITY_ADMIN_TOKEN}`,
    },
    body: JSON.stringify(buildBackfillBody(deploymentId(), users)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`identity backfill HTTP ${res.status}`);
  const data = (await res.json()) as { links?: Record<string, string> };
  return data.links ?? {};
}

/** Trade a one-time sign-in code for an identity token, server-to-server.
 *
 *  The code arrives in the browser's URL; the token does not, and that asymmetry is the
 *  point. This surface proves it is itself with IDENTITY_DEPLOYMENT_SECRET, so a code
 *  seen in a log or a Referer header cannot be redeemed by whoever saw it.
 *
 *  Returns null for any refusal. The account service answers identically for a bad code
 *  and a bad secret on purpose, so there is nothing here worth distinguishing either. */
export async function redeemIdentityCode(code: string): Promise<string | null> {
  if (!env.IDENTITY_URL || !env.IDENTITY_DEPLOYMENT_SECRET) return null;
  try {
    const res = await fetch(base() + "/authorize/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        deployment: deploymentId(),
        secret: env.IDENTITY_DEPLOYMENT_SECRET,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

/** Shape the account service's /me into what provisioning needs, or null if it cannot.
 *
 *  Separated from the fetch so the decisions here are testable: an address is lowercased
 *  before it is ever compared to a local one (otherwise the same person arrives as a
 *  second account the first time they capitalise it), a missing display name falls back
 *  to the local-part rather than blanking the workspace name, and `emailVerified` is
 *  true ONLY for a literal true — a missing field must never read as verified, since
 *  that flag is the whole defence against adopting someone else's account. */
export function profileFromMe(body: unknown): IdentityProfile | null {
  const identity = (body as { identity?: { email?: unknown; display_name?: unknown; email_verified?: unknown } })?.identity;
  const email = typeof identity?.email === "string" ? identity.email.trim().toLowerCase() : "";
  if (!email) return null;
  const name = typeof identity?.display_name === "string" ? identity.display_name.trim() : "";
  return {
    email,
    displayName: name || email.split("@")[0]!,
    emailVerified: identity?.email_verified === true,
  };
}

export interface IdentityProfile {
  email: string;
  displayName: string;
  emailVerified: boolean;
}

/** The account's own view of itself, read with the identity token we just verified.
 *
 *  The token carries only `sub` — no email, no name — and that is the right trade: a
 *  30-day token with an email claim in it goes stale the moment someone changes their
 *  address, and widens what a leaked one reveals. Provisioning is the only path that
 *  needs the profile, so it is fetched then, fresh, and never cached.
 *
 *  Returns null on anything unexpected, and the caller treats that as "cannot
 *  provision" rather than inventing a placeholder account. */
export async function fetchIdentityProfile(token: string): Promise<IdentityProfile | null> {
  if (!env.IDENTITY_URL) return null;
  try {
    const res = await fetch(base() + "/me", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return profileFromMe(await res.json());
  } catch {
    return null;
  }
}