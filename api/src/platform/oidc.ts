// Sign in with the instance's own OpenID Connect provider (#4492): Authentik,
// Authelia, Keycloak, Pocket ID, anything that speaks OIDC. Self-host first:
// nothing here exists until an operator sets a provider up, so a hosted
// surface has none unless its owner adds one.
//
// The protocol is openid-client's, never hand-rolled: discovery, the
// authorization code flow with PKCE (S256), state and nonce, and the ID
// token's signature, issuer, audience and expiry are all checked by it. What
// this file owns is the decisions around it:
//
//   - state, nonce and the PKCE verifier live in oidc_logins, one row per
//     sign-in started, single use, ten minutes; the callback finds its row by
//     the state's hash and spends it before anything else, so a replayed or
//     forged callback finds nothing.
//   - a provider account becomes a Cobblr user only with proof. A person
//     already signed in here links it (purpose "link"); or the provider makes
//     a NEW account when the operator allowed that, for a verified address
//     nobody here uses. A matching email alone never links: whoever controls
//     an address at some provider is not thereby the person whose account
//     uses it here.
//   - the client secret is encrypted with the instance key, never returned,
//     never logged, never in a URL.
//   - the browser gets a one-time code from the callback, traded for a session
//     by POST (oidc_handoffs), so no session token rides in a URL.
//
// BORN WITH: nothing (the provider is the instance's, not a workspace's: a new
// workspace has no sign-in of its own to be born with)
//
// Password sign-in can be turned off only once a platform admin has signed in
// through an enabled provider (passwordOffRefusal), so nobody locks the
// instance out; `node dist/cli/password-sign-in.js on` turns it back on.

import { productName } from "./product-name.js";
import { createHash, randomBytes } from "node:crypto";
import * as client from "openid-client";
import { z } from "zod";
import { INVITABLE_ORG_ROLES, ORG_ROLE_RANK, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { meta } from "../db/meta.js";
import { decryptCreds, encryptCreds } from "../db/crypto.js";
import type { OidcProvidersTable } from "../db/schema.js";
import type { Selectable } from "kysely";
import { isPlatformAdmin } from "../auth/middleware.js";

export type ProviderRow = Selectable<OidcProvidersTable>;

/** A mapping from a provider group to a role in one workspace. `lower`: also
 *  lower a role set by hand above it (otherwise a hand-set role only rises). */
export const GroupRole = z.object({
  group: z.string().min(1).max(200),
  org_slug: z.string().min(1).max(100),
  role: z.enum(INVITABLE_ORG_ROLES),
  lower: z.boolean().optional(),
});
export type GroupRole = z.infer<typeof GroupRole>;

const hash = (plain: string) => createHash("sha256").update(plain).digest("hex");

/** What any response may say about a provider: never the secret. */
export function publicProvider(p: ProviderRow) {
  return {
    id: p.id,
    slug: p.slug,
    display_name: p.display_name,
    issuer: p.issuer,
    client_id: p.client_id,
    has_secret: !!p.client_secret_enc,
    scopes: p.scopes,
    email_claim: p.email_claim,
    groups_claim: p.groups_claim,
    allow_signup: p.allow_signup,
    signup_groups: p.signup_groups,
    group_roles: p.group_roles,
    allow_http: p.allow_http,
    enabled: p.enabled,
    from_env: p.from_env,
    updated_at: p.updated_at,
  };
}

export const sealSecret = (secret: string): string => encryptCreds(secret);

// ── Discovery, cached per provider version ──────────────────────────────────
// single-flight: one discovery fetch per provider per sign-in (10 minute TTL); a duplicate concurrent fetch is harmless and is not a list row
const configs = new Map<string, { at: number; config: client.Configuration }>();
const CONFIG_TTL_MS = 10 * 60_000;

export async function providerConfig(p: ProviderRow): Promise<client.Configuration> {
  const key = `${p.id}:${new Date(p.updated_at).getTime()}`;
  const hit = configs.get(key);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.config;
  const secret = p.client_secret_enc ? decryptCreds(p.client_secret_enc) : undefined;
  const config = await client.discovery(
    new URL(p.issuer),
    p.client_id,
    secret,
    // client_secret_basic: the method every OIDC provider must support, and
    // Authelia's default for a registered client.
    secret ? client.ClientSecretBasic(secret) : client.None(),
    // An operator's explicit choice for a provider on a LAN without TLS.
    p.allow_http ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  configs.set(key, { at: Date.now(), config });
  return config;
}

/** What a provider offers, for the operator's Test button. Never the secret. */
export async function describeProvider(p: ProviderRow): Promise<{ ok: true; issuer: string; scopes: string[]; claims: string[]; end_session: boolean } | { ok: false; message: string }> {
  try {
    const m = (await providerConfig(p)).serverMetadata();
    return {
      ok: true,
      issuer: m.issuer,
      scopes: (m.scopes_supported as string[] | undefined) ?? [],
      claims: (m.claims_supported as string[] | undefined) ?? [],
      end_session: !!m.end_session_endpoint,
    };
  } catch (err) {
    return { ok: false, message: safeMessage(err, p) };
  }
}

/** An error's words with the provider's secret taken out, whatever the
 *  library put in them: the only form an OIDC error is logged or answered. */
export function safeMessage(err: unknown, p: Pick<ProviderRow, "client_secret_enc">): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (p.client_secret_enc) {
    try {
      const secret = decryptCreds(p.client_secret_enc);
      if (secret) msg = msg.split(secret).join("[secret]");
    } catch {
      /* quiet: an unreadable secret cannot be in the message either */
    }
  }
  return msg.slice(0, 300);
}

// ── Starting a sign-in ──────────────────────────────────────────────────────
export async function startLogin(p: ProviderRow, purpose: "signin" | "link", userId: string | null, redirectUri: string): Promise<string> {
  const config = await providerConfig(p);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const verifier = client.randomPKCECodeVerifier();
  await meta
    .insertInto("oidc_logins")
    .values({ state_hash: hash(state), nonce, code_verifier: verifier, redirect_uri: redirectUri, provider_id: p.id, purpose, user_id: userId })
    .execute();
  return client
    .buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: p.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    })
    .toString();
}

// ── The callback ────────────────────────────────────────────────────────────
export type Refusal = { code: string; message: string };
export type CallbackOutcome =
  | { kind: "signed-in"; userId: string; provider: ProviderRow; groups: string[] }
  | { kind: "linked"; userId: string; provider: ProviderRow }
  | { kind: "new-account"; provider: ProviderRow; subject: string; email: string; name: string; groups: string[] }
  | { kind: "refused"; refusal: Refusal; provider?: ProviderRow };

const refused = (code: string, message: string, provider?: ProviderRow): CallbackOutcome => ({ kind: "refused", refusal: { code, message }, provider });

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const v = claims[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function claimGroups(claims: Record<string, unknown>, name: string): string[] {
  const v = claims[name];
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === "string");
  return typeof v === "string" && v ? [v] : [];
}

/** The provider sent the browser back: check everything, then decide. */
export async function finishLogin(callbackUrl: URL): Promise<CallbackOutcome> {
  const state = callbackUrl.searchParams.get("state");
  if (!state) return refused("bad_state", "That sign-in did not come from here. Start it again.");
  // Spend the row first: a replay (or a second tab) finds nothing.
  const login = await meta
    .updateTable("oidc_logins")
    .set({ consumed_at: new Date() })
    .where("state_hash", "=", hash(state))
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .returningAll()
    .executeTakeFirst();
  if (!login) return refused("bad_state", "That sign-in did not come from here, was already used, or took too long. Start it again.");
  const provider = await meta.selectFrom("oidc_providers").selectAll().where("id", "=", login.provider_id).executeTakeFirst();
  if (!provider || !provider.enabled) return refused("provider_off", "That way of signing in is turned off here.");
  if (callbackUrl.searchParams.get("error")) {
    return refused("provider_said_no", `${provider.display_name} did not sign you in: ${callbackUrl.searchParams.get("error_description") ?? callbackUrl.searchParams.get("error")}`.slice(0, 300), provider);
  }

  let claims: Record<string, unknown>;
  try {
    const config = await providerConfig(provider);
    // The callback URL the provider used, rebuilt on the redirect URI this
    // sign-in registered: the request's own host never decides it.
    const current = new URL(login.redirect_uri);
    current.search = callbackUrl.search;
    const tokens = await client.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: login.code_verifier,
      expectedState: state,
      expectedNonce: login.nonce,
      idTokenExpected: true,
    });
    claims = { ...(tokens.claims() ?? {}) } as Record<string, unknown>;
    // Some providers put email or groups only in userinfo.
    if ((!claims[provider.email_claim] || claims[provider.groups_claim] === undefined) && tokens.access_token) {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, String(claims.sub));
        claims = { ...info, ...claims };
      } catch (err) {
        console.warn(`[oidc] ${provider.slug}: userinfo unavailable: ${safeMessage(err, provider)}`);
      }
    }
  } catch (err) {
    console.error(`[oidc] ${provider.slug}: sign-in failed the checks: ${safeMessage(err, provider)}`);
    return refused("token_rejected", `${provider.display_name} answered, but its answer did not pass the checks, so nobody was signed in. Try again; if it keeps happening, the operator should check the provider's settings.`, provider);
  }

  const subject = claimString(claims, "sub");
  if (!subject) return refused("token_rejected", "The provider did not say who you are.", provider);
  const email = claimString(claims, provider.email_claim)?.toLowerCase() ?? null;
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const groups = claimGroups(claims, provider.groups_claim);
  const linked = await meta.selectFrom("user_oidc_links").select(["user_id"]).where("provider_id", "=", provider.id).where("subject", "=", subject).executeTakeFirst();

  if (login.purpose === "link") {
    if (!login.user_id) return refused("bad_state", "Start linking from your account again.", provider);
    if (linked && linked.user_id !== login.user_id) {
      return refused("linked_elsewhere", `That ${provider.display_name} account already signs in to another account here.`, provider);
    }
    if (!linked) {
      const other = await meta.selectFrom("user_oidc_links").select("subject").where("provider_id", "=", provider.id).where("user_id", "=", login.user_id).executeTakeFirst();
      if (other) return refused("already_linked", `Your account is linked to a different ${provider.display_name} account. Unlink it first.`, provider);
      // A second tab finishing the same link at once: linked already.
      await meta.insertInto("user_oidc_links").values({ user_id: login.user_id, provider_id: provider.id, subject, email_at_link: email, last_used_at: new Date() }).onConflict((oc) => oc.doNothing()).execute();
    }
    return { kind: "linked", userId: login.user_id, provider };
  }

  if (linked) {
    const user = await meta.selectFrom("users").select(["active"]).where("id", "=", linked.user_id).executeTakeFirst();
    if (!user?.active) return refused("account_disabled", "This account is turned off here.", provider);
    await meta.updateTable("user_oidc_links").set({ last_used_at: new Date() }).where("provider_id", "=", provider.id).where("subject", "=", subject).execute();
    return { kind: "signed-in", userId: linked.user_id, provider, groups };
  }

  // Not linked. A matching email is NOT proof (see the header): say what to do.
  if (email) {
    const existing = await meta.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (existing) {
      return refused(
        "link_first",
        `An account here already uses ${email}. Sign in the usual way, then link ${provider.display_name} from Your account → Identity & password; after that this button signs you in.`,
        provider,
      );
    }
  }
  if (!provider.allow_signup) return refused("no_account", `There is no account here for your ${provider.display_name} sign-in, and new accounts are made by invitation. Ask whoever runs this ${productName()}.`, provider);
  if (!email) return refused("no_email", `${provider.display_name} did not share an email address, which a new account needs.`, provider);
  if (!verified) return refused("email_unverified", `${provider.display_name} has not verified ${email}, so no account is made for it here.`, provider);
  if (provider.signup_groups.length > 0 && !groups.some((g) => provider.signup_groups.includes(g))) {
    return refused("not_in_group", `New accounts here are for members of ${provider.signup_groups.join(", ")} at ${provider.display_name}.`, provider);
  }
  const name = claimString(claims, "name") ?? claimString(claims, "preferred_username") ?? email.split("@")[0] ?? "user";
  return { kind: "new-account", provider, subject, email, name, groups };
}

// ── Groups to roles, at every sign-in ───────────────────────────────────────
export async function applyGroupRoles(userId: string, provider: ProviderRow, groups: string[]): Promise<void> {
  const parsed = z.array(GroupRole).safeParse(provider.group_roles);
  if (!parsed.success || parsed.data.length === 0) return;
  // The highest role each workspace's matching rows give.
  const want = new Map<string, GroupRole>();
  for (const r of parsed.data) {
    if (!groups.includes(r.group)) continue;
    const cur = want.get(r.org_slug);
    if (!cur || ORG_ROLE_RANK[r.role] > ORG_ROLE_RANK[cur.role]) want.set(r.org_slug, r);
  }
  for (const [slug, r] of want) {
    const org = await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!org) continue;
    const m = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", org.id).where("user_id", "=", userId).executeTakeFirst();
    if (!m) {
      await meta.insertInto("org_memberships").values({ org_id: org.id, user_id: userId, role: r.role }).onConflict((oc) => oc.columns(["user_id", "org_id"]).doNothing()).execute();
      await logRole(org.id, userId, null, r.role, provider);
      continue;
    }
    const have = ORG_ROLE_RANK[m.role as OrgRoleName] ?? 0;
    // The owner is never moved by a mapping; a hand-set role only rises,
    // unless the mapping says lower.
    if (m.role === "owner") continue;
    if (ORG_ROLE_RANK[r.role] > have || (r.lower && ORG_ROLE_RANK[r.role] < have)) {
      await meta.updateTable("org_memberships").set({ role: r.role }).where("org_id", "=", org.id).where("user_id", "=", userId).execute();
      await logRole(org.id, userId, m.role, r.role, provider);
    }
  }
}
async function logRole(orgId: string, userId: string, from: string | null, to: string, provider: ProviderRow): Promise<void> {
  const activity = await import("./activity.js");
  await activity
    .log({ orgId, userId, action: from ? "member_role_changed" : "member_joined", ref: { module: null, entityType: "membership", entityId: userId }, diff: { from, to, via: `oidc:${provider.slug}` } })
    .catch((err) => console.error("[oidc] activity log failed:", (err as Error).message));
}

// ── The browser hand-off ────────────────────────────────────────────────────
export async function mintHandoff(userId: string, providerId: string): Promise<string> {
  const plain = randomBytes(32).toString("base64url");
  await meta.insertInto("oidc_handoffs").values({ code_hash: hash(plain), user_id: userId, provider_id: providerId }).execute();
  return plain;
}
export async function redeemHandoff(code: string): Promise<{ userId: string; providerSlug: string } | null> {
  const row = await meta
    .updateTable("oidc_handoffs")
    .set({ consumed_at: new Date() })
    .where("code_hash", "=", hash(code))
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .returning(["user_id", "provider_id"])
    .executeTakeFirst();
  if (!row) return null;
  const p = await meta.selectFrom("oidc_providers").select("slug").where("id", "=", row.provider_id).executeTakeFirst();
  return { userId: row.user_id, providerSlug: p?.slug ?? "" };
}

// ── Password sign-in on or off ──────────────────────────────────────────────
export async function passwordSignInOn(): Promise<boolean> {
  const row = await meta.selectFrom("instance_sign_in").select("password_signin").executeTakeFirst();
  return row?.password_signin !== false;
}

/** Why password sign-in may not be turned off yet, or null when it may: a
 *  platform admin must have signed in through an enabled provider, or turning
 *  it off would leave the instance with no admin able to get in. */
export function passwordOffRefusal(adminsSignedInThroughAProvider: number): string | null {
  return adminsSignedInThroughAProvider > 0
    ? null
    : "Sign in through your provider as a platform admin first. Until one has, turning password sign-in off could lock every admin out.";
}

export async function adminsSignedInThroughAProvider(): Promise<number> {
  const rows = await meta
    .selectFrom("user_oidc_links as l")
    .innerJoin("oidc_providers as p", "p.id", "l.provider_id")
    .innerJoin("users as u", "u.id", "l.user_id")
    .select(["u.email"])
    .where("p.enabled", "=", true)
    .where("l.last_used_at", "is not", null)
    .where("u.active", "=", true)
    .execute();
  return rows.filter((r) => isPlatformAdmin(r.email)).length;
}

export async function setPasswordSignIn(on: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!on) {
    const why = passwordOffRefusal(await adminsSignedInThroughAProvider());
    if (why) return { ok: false, message: why };
  }
  await meta.updateTable("instance_sign_in").set({ password_signin: on, updated_at: new Date() }).execute();
  return { ok: true };
}

// ── A first boot with no UI: COBBLR_OIDC_* seeds one provider ───────────────
export async function seedProviderFromEnv(): Promise<void> {
  const issuer = (process.env.COBBLR_OIDC_ISSUER || "").trim();
  const clientId = (process.env.COBBLR_OIDC_CLIENT_ID || "").trim();
  if (!issuer || !clientId) return;
  const secret = (process.env.COBBLR_OIDC_CLIENT_SECRET || "").trim();
  const slug = (process.env.COBBLR_OIDC_SLUG || "sso").trim().toLowerCase();
  const name = (process.env.COBBLR_OIDC_NAME || "your sign-in").trim();
  const existing = await meta.selectFrom("oidc_providers").select(["id", "from_env"]).where("slug", "=", slug).executeTakeFirst();
  // One the operator set up in the UI under the same name is theirs: left alone.
  if (existing && !existing.from_env) return;
  const values = { display_name: name, issuer, client_id: clientId, client_secret_enc: secret ? sealSecret(secret) : null, from_env: true, updated_at: new Date() };
  if (existing) await meta.updateTable("oidc_providers").set(values).where("id", "=", existing.id).execute();
  // check-then-insert: boot seeding: one api process, once, before it serves
  else await meta.insertInto("oidc_providers").values({ slug, ...values }).execute();
}

/** The provider's sign-out address, when it advertises one (RP-initiated logout). */
export async function endSessionUrl(p: ProviderRow, postLogoutRedirect: string): Promise<string | null> {
  try {
    const config = await providerConfig(p);
    if (!config.serverMetadata().end_session_endpoint) return null;
    return client.buildEndSessionUrl(config, { post_logout_redirect_uri: postLogoutRedirect, client_id: p.client_id }).toString();
  } catch (err) {
    console.warn(`[oidc] ${p.slug}: no sign-out address: ${safeMessage(err, p)}`);
    return null;
  }
}
