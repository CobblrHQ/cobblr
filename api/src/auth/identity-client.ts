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

/** This surface's stable id in the identity map (deployment_links). */
export function deploymentId(): string {
  return env.COBBLR_DEPLOYMENT || env.COBBLR_ENV || "default";
}

function base(): string {
  return (env.IDENTITY_URL ?? "").replace(/\/+$/, "");
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

/** Log the federation config once at boot. A wrong IDENTITY_ISSUER/AUDIENCE makes EVERY
 *  exchange 401 indistinguishably from a bad token ("SSO just doesn't work"), so surface
 *  exactly what this surface is configured to verify + where. No-op unless enabled. */
export function logIdentityConfig(): void {
  if (!identityEnabled()) return;
  console.log(
    `[identity] federation ON — url=${base()} deployment=${deploymentId()} ` +
      `issuer=${env.IDENTITY_ISSUER} audience=${env.IDENTITY_AUDIENCE} jwks=${base()}/.well-known/jwks.json`,
  );
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
