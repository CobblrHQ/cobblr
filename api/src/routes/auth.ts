import { withArticle } from "@cobblr/platform-contract/plural";
import { currencyFromLocale } from "@cobblr/platform-contract/money";
// /api/v1/auth — signup, login. Minimal for Phase 0:
//
//   POST /signup  { email, password, display_name, org_name }
//     Creates user + first org + owner membership atomically.
//     Returns { token, user, orgs }.
//
//   POST /login   { email, password }
//     Returns { token, user, orgs }.
//
// Signup-creates-an-org because invite flow is deferred. Every user
// in Phase 0 owns at least one org (their own). Tenant DB provisioning
// happens in milestone 3 — the org row here just reserves the db_name.

import { IP_LIMITS_OFF as AUTH_LIMITS_OFF, makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { decodeInvite, hereUrl, readInvite } from "../platform/share-links.js";
import { trustedPeers } from "../platform/cloud.js";
import { publicOrigin } from "./edge.js";
import { meta, metaPool } from "../db/meta.js";
import { isUndeliverableAddress } from "../platform/usernames.js";
import { attemptPasswordLogin, clearLoginAttempts, recordFailedLogin } from "../auth/password-login.js";
import { applyBlueprint, BlueprintManifest } from "./blueprint.js";
import { provisionWholeOrRemove, WorkspaceNotProvisioned, WORKSPACE_NOT_CREATED_MESSAGE } from "../platform/provision-workspace.js";
import type { TemplateSet } from "../db/workspace-template.js";
import { slugifyBase } from "../lib/slugify.js";
import { hashPassword } from "../auth/password.js";
import { TRIAL_MODE, TRIAL_TTL_DAYS } from "../platform/trial.js";
import { captchaVerdict, captchaRefusal, captchaEnabled } from "../platform/captcha.js";
import { blockDisposableEnabled, isDisposableEmail } from "../platform/disposable-emails.js";
import { confirmEmailChange, revertEmailChange } from "../platform/email-change.js";
import { linkOrigin } from "../platform/link-origin.js";
import { productName } from "../platform/product-name.js";

// A throwaway hash, computed once, so the "no such user / inactive" login
// path spends the same ~bcrypt time as a real password check — otherwise the
// timing difference leaks which emails are registered. (Audit 2026-06-26 P2.)
import { signSession } from "../auth/jwt.js";
import { loadSessionUser } from "../auth/session-user.js";
import { listMembershipsForUser } from "../platform/memberships.js";
import {
  identityEnabled,
  identityCallbackEnabled,
  deploymentId,
  autoProvisionEnabled,
  verifyIdentityToken,
  redeemIdentityCode,
  fetchIdentityProfile,
  browserBase,
  deploymentSecretMatches,
  signupOnPageEnabled,
  surfaceAccountCall,
  callbackReturnTo,
  currentAccountTerms,
} from "../auth/identity-client.js";
import { hardDeleteUser } from "../platform/delete-user.js";
import { passwordSignInOn } from "../platform/oidc.js";
import { isPlatformAdmin, requireAuth } from "../auth/middleware.js";
import { publicSignupEnabled, managedAppSignupEnabled, selfServeInvitesEnabled } from "../auth/signup-gate.js";
import { dispatch } from "../platform/notifications.js";
import { createAccount } from "../platform/accounts.js";
import { isUndeliverableTestAddress } from "../platform/email-send.js";
import * as activity from "../platform/activity.js";
import { activeAuthEmailSender, fireSignup, sendAuthEmail } from "../platform/hosted-seams.js";
import { discordAppId } from "../platform/discord-oauth.js";
import { communityLinks, discordInviteUrl, type CommunityLink } from "../platform/community.js";
import { provisionAppWorkspace, ProvisionAppError } from "../platform/provision-app.js";
import { getManagedApp } from "../platform/managed-apps.js";
import { planIdentityWorkspace } from "../platform/identity-provision.js";
import { recordSignup } from "../platform/signup-source.js";
import type { OrgRole } from "../db/schema.js";

class SkipNotify extends Error {}

/** Does this share invite let its person sign up here? Made here or by a
 *  Cobblr this one trusts, and still good (its owner's Cobblr says so). */
async function shareInviteAdmits(raw: string, here: string): Promise<boolean> {
  const token = decodeInvite(raw);
  if (!token) return false;
  let from: string;
  try {
    from = new URL(token.u).origin;
  } catch {
    return false;
  }
  if (from !== new URL(here || "http://invalid").origin && !trustedPeers().includes(from)) return false;
  return readInvite(token, here).then(
    () => true,
    () => false,
  );
}

export const authRouter = Router();

// ─────────────────────────── helpers ────────────────────────────

// When "true", a new account can't get a working session until its email is
// verified: signup withholds the auto-login token and login is denied while
// unverified. Needs a real auth-email sender configured, else nobody can verify.
const requireEmailVerify = () => (process.env.COBBLR_REQUIRE_EMAIL_VERIFY ?? "").trim() === "true";

const SignupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(120),
  // Captcha token (e.g. Cloudflare Turnstile). Verified server-side only when a
  // captcha provider is configured (the trial tier); ignored otherwise.
  captcha_token: optionalText(4096),
  // Optional when `app` is set — a managed-app signup names the workspace
  // after the app (the consumer never picks a workspace name).
  org_name: z.string().min(1).max(120).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  /** The link or QR that sent the person here (`?source=`), recorded on the
   *  account's signed_up event. Cleaned, never refused (signup-source.ts). */
  source: z.string().max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  /** Single-use signup-invite token. When public signup is disabled, a
   *  valid token authorises this registration (the invite-only gate). */
  invite_token: optionalText(200),
  /** A share invite (/share/join#<token>) the person is signing up to accept.
   *  From this Cobblr or one it trusts, it counts as their invitation when
   *  public signup is off (#4737). */
  share_invite: optionalField(z.string().min(8).max(4000)),
  /** Managed-app signup ("Cobblr for Yarn"): provision the user's first (only)
   *  workspace AS this app — install its flagship bundle + lock it into app
   *  mode — instead of a generic workspace. `manifest` is the app's bundle
   *  (caller-supplied for now; server-side registry fetch is the follow-up). */
  app: z.string().min(1).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  manifest: z.unknown().optional(),
});

const LoginBody = z.object({
  // An email or a username (#6910). `email` is kept for the field's old name.
  identifier: optionalField(z.string().trim().min(1).max(255)),
  email: optionalField(z.string().trim().min(1).max(255)),
  password: z.string().min(1).max(128),
  // Where an account whose address is still unconfirmed comes back to after the
  // fresh link this sends it: the app and source the page was opened with.
  app: z.string().min(1).max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  source: z.string().max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
}).refine((b) => !!(b.identifier ?? b.email), { message: "Give an email or a username." });

/** Candidate slugs in preference order: the bare name, then `-2`, `-3`, … on
 *  collision, and finally a random suffix as an (astronomically unlikely)
 *  backstop so signup never hard-fails on a very hot name. The DB's
 *  `orgs_slug_key` unique constraint is the source of truth — the insert loop
 *  in provisionOrgForUser walks these until one lands. No more unconditional
 *  `-<4hex>` suffix: clean slugs the user never has to look past. */
function* slugCandidates(name: string): Generator<string> {
  const base = slugifyBase(name);
  yield base;
  for (let n = 2; n <= 99; n++) yield `${base}-${n}`;
  for (;;) yield `${base}-${randomShortId(4)}`;
}

/** `tenant_<12-hex>` — short enough to read in logs, long enough to
 *  not collide before the heat death of the universe. */
function tenantDbName(): string {
  return `tenant_${randomShortId(12)}`;
}

function randomShortId(len: number): string {
  // Crypto-grade — slug suffixes don't need it, but db_name does.
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

interface AuthResponseUser {
  id: string;
  email: string;
  display_name: string;
  /** True when the user must pick a new password before doing
   *  anything substantive — admin minted the account with a temp
   *  password. Web client renders the set-a-password screen in place
   *  of every route until the flag is cleared via PATCH /me/password.
   *  A gate, not a URL - there is nothing to navigate around. */
  must_reset_password: boolean;
  /** True once the user confirmed their email via a verification link.
   *  Informational (login is not gated on it); the web shows a "verify your
   *  email" banner while false. Existing users were grandfathered to true. */
  email_verified: boolean;
  /** True when the user's email is in SUPERADMIN_EMAILS. Must be set
   *  on the login/signup response too (not just /me) — else the
   *  super-admin UI shows "access denied" until the next /me refresh. */
  is_platform_admin: boolean;
  /** The account-level preferences, on the login payload for the same reason
   *  `is_platform_admin` is: the client acts on them the moment it renders, and
   *  a response that omits one is read as "no preference", not as "not told".
   *  Signing in used to come up in the wrong theme for exactly that reason.
   *  null means "follow this device"; these are never absent here. */
  theme_pref: "light" | "dark" | null;
  title_pref?: string | null;
  nav_pref: unknown;
  tour_seen_at: Date | string | null;
  /** The IANA zone the person's browser last reported, or null (users.time_zone). */
  time_zone: string | null;
  /** Tips shown and dismissed (see users.tips). */
  tips: { shown?: Record<string, string>; dismissed?: Record<string, string> };
  /** Community Discord invite (see discordInviteUrl) or null; signed-in chrome only. */
  discord_invite_url: string | null;
  /** Every place this deployment offers for questions, in the order to show
   *  them. `discord_invite_url` stays for older clients; it is the chat entry
   *  of this list. */
  community_links: CommunityLink[];
}

interface AuthResponseOrg {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  /** Set when this workspace is a managed vertical app — the web hides all
   *  platform chrome and lands the user in `app_mode.home_path`. */
  app_mode: { app: string; home_path: string; label?: string } | null;
}

interface AuthResponse {
  token: string;
  user: AuthResponseUser;
  orgs: AuthResponseOrg[];
}

/** Provision a new org for an existing user: insert org row, write
 *  owner membership, provision the tenant DB, enable all installed
 *  modules, seed default bindings. Used by signup (for the user's
 *  first org) and POST /orgs (for additional ones).
 *
 *  Returns the new org id + slug. Failures inside DB provisioning
 *  leave the org row in place (db_credentials_encrypted null) so
 *  the user can still see it and an operator can re-provision. */
export async function provisionOrgForUser(
  userId: string,
  orgName: string,
  // The test pool's workspaces turn every module on, so theirs is copied from
  // the template that has them all (db/workspace-template.ts).
  opts: { template?: TemplateSet } = {},
): Promise<{ orgId: string; slug: string; dbName: string; provisioned: boolean }> {
  const dbName = tenantDbName();
  const client = await metaPool.connect();
  let orgId: string;
  let slug: string;
  try {
    // Walk slug candidates (bare name → -2, -3, …) until one doesn't collide.
    // `orgs_slug_key` enforces uniqueness, so this is race-safe: a concurrent
    // signup that grabbed the name first trips the constraint and we retry.
    const candidates = slugCandidates(orgName);
    for (;;) {
      slug = candidates.next().value as string;
      try {
        await client.query("begin");
        // On the trial tier, stamp a 30-day (TRY_TTL_DAYS) expiry so
        // `trial_expires_at IS NOT NULL` marks a trial workspace. Reaping is
        // deferred — this is just the stamp; nothing sweeps yet. NULL everywhere
        // else (prod/staging/self-host).
        const trialExpiresAt = TRIAL_MODE
          ? new Date(Date.now() + TRIAL_TTL_DAYS * 86_400_000)
          : null;
        const orgRow = await client.query<{ id: string }>(
          `insert into orgs (name, slug, db_name, trial_expires_at)
           values ($1, $2, $3, $4)
           returning id`,
          [orgName.trim(), slug, dbName, trialExpiresAt],
        );
        orgId = orgRow.rows[0]!.id;
        // Append the new workspace at the BOTTOM of the user's switcher
        // (position = their current max + 1) so a freshly-created one lands last
        // and they drag it where they want — not above the existing ones.
        await client.query(
          `insert into org_memberships (user_id, org_id, role, position)
           values ($1, $2, 'owner',
                   coalesce((select max(position) from org_memberships where user_id = $1), -1) + 1)`,
          [userId, orgId],
        );
        await client.query("commit");
        break;
      } catch (err) {
        await client.query("rollback");
        // Retry the NEXT candidate only on a slug-uniqueness collision;
        // anything else (incl. the random db_name colliding) is a real error.
        const e = err as { code?: string; constraint?: string };
        if (e?.code === "23505" && (e.constraint ?? "").includes("slug")) continue;
        throw err;
      }
    }
  } finally {
    client.release();
  }

  // The database, its credentials and the default modules. Made whole or not
  // at all (platform/provision-workspace.ts): one more try from a clean slate,
  // then the row goes and the caller hears WorkspaceNotProvisioned, instead of
  // a workspace that answers 503 on every page for good.
  await provisionWholeOrRemove(orgId, orgName, userId, { template: opts.template });

  try {
    await activity.log({
      orgId,
      userId,
      action: "org_created",
      ref: { module: null, entityType: "org", entityId: orgId },
      diff: { name: orgName, db_name: dbName },
    });
  } catch (err) {
    console.error("[org-provision] activity logging failed:", err);
  }
  const provisioned = true as const;

  return { orgId, slug, dbName, provisioned };
}

export async function buildAuthResponse(userId: string): Promise<AuthResponse> {
  // Shared with GET /me. The two used to select their own columns and drifted:
  // /me carried the account preferences and this did not, so signing in landed
  // you in the wrong theme until you refreshed.
  const user = await loadSessionUser(userId);

  const orgs = await listMembershipsForUser(userId);

  const token = await signSession(userId);
  return {
    token,
    user: {
      ...user,
      is_platform_admin: isPlatformAdmin(user.email),
      discord_invite_url: discordInviteUrl() || null,
      community_links: communityLinks(),
    },
    orgs,
  };
}

// ────────────────────────── GET /config ──────────────────────────
//
// Anonymous-readable feature flags the web client needs before the
// user has logged in (e.g. whether to render the "create account"
// link). Add fields here as more anonymous-time toggles appear;
// don't repurpose /api/v1/healthz for auth UI hints.

/** Where a phone fetches an Offline CA install's root certificate, or null. */
export function phoneCertificateUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const site = (env.COBBLR_SITE_ADDRESS ?? "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return env.COBBLR_TLS_MODE === "internal" && site ? `http://${site}/cobblr-root.crt` : null;
}

authRouter.get("/config", async (req, res) => {
  if (overLimit(configLimiter, req)) return rateLimited(res);
  // The same answer for every visitor of a deployment: a shared cache may hold
  // it for a minute, which also spares the limit a page reload's worth.
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.json({
    // What this server calls itself in the words its people read (#6815).
    product_name: productName(),
    signup_enabled: publicSignupEnabled(),
    self_serve_invites: selfServeInvitesEnabled(),
    // Which sender delivers auth email: "byo:smtp" (configured here), "overlay"
    // (a hosted overlay's), or null (none: links show inline). A name only. A
    // staging that must never mail a person asserts its own here (2026-10-10).
    email_sender: activeAuthEmailSender(),
    // Captcha for the signup form. Null unless a provider + secret are configured
    // server-side (the trial tier). The site key is public; the secret never is.
    captcha: captchaEnabled()
      ? {
          provider: process.env.COBBLR_CAPTCHA_PROVIDER,
          site_key: (process.env.COBBLR_CAPTCHA_SITE_KEY ?? "").trim() || null,
        }
      : null,
    // Hosted (the managed service) vs self-hosted. Self-hosted by default; the
    // managed/public-prod deployment sets COBBLR_HOSTED=true. Drives client hints
    // such as "a hosted Cobblr can't reach your LAN device directly".
    hosted: process.env.COBBLR_HOSTED === "true",
    // An Offline CA install (the setup builder's COBBLR_TLS_MODE=internal) signs
    // its own certificate, so a phone must trust that CA once before its camera
    // works (a camera needs a secure context). The bundled Caddy serves the root
    // certificate on plain HTTP at this address, and the pairing screen shows it
    // as a QR, so that is one scan (#6443). Null on every other install.
    phone_certificate_url: phoneCertificateUrl(),
    // Whether this server can send Web Push (#5565): its key pair exists. The
    // public key itself is public by nature, but a yes is all a page (or an
    // operator checking a deployment with curl) needs. null: could not be read.
    web_push: await webPushReady(),
    // Central identity, for the "sign in with your Cobblr account" button. Null unless
    // BOTH halves are configured, because a button that starts a hand-off this surface
    // cannot finish is worse than no button: it fails after the redirect, on somebody
    // else's site, where nothing here can explain it.
    //
    // `authorize_url` is where the browser goes; the surface names itself so the
    // account service knows which secret to expect back.
    // A public demo's shared login, shown on and pre-filled into the sign-in
    // form. Null unless BOTH halves are set, deliberately: a demo credential is
    // meant to be public, so the opt-in has to be explicit and unmistakable
    // rather than something a missing variable could half-enable.
    demo_signin:
      (process.env.COBBLR_DEMO_SIGNIN_EMAIL ?? "").trim() && (process.env.COBBLR_DEMO_SIGNIN_PASSWORD ?? "").trim()
        ? {
            email: (process.env.COBBLR_DEMO_SIGNIN_EMAIL ?? "").trim(),
            password: (process.env.COBBLR_DEMO_SIGNIN_PASSWORD ?? "").trim(),
            note: (process.env.COBBLR_DEMO_SIGNIN_NOTE ?? "").trim() || null,
          }
        : null,
    identity: identityCallbackEnabled()
      ? {
          authorize_url: `${browserBase()}/authorize`,
          deployment: deploymentId(),
          // Whose account it is. Configurable because nothing else in this feature is
          // Cobblr-specific: point IDENTITY_URL at your own service and the button
          // should say your name, not ours.
          name: (process.env.IDENTITY_NAME ?? "").trim() || /* PRODUCT-NAME: The separately operated identity service has its own account name. */ "Cobblr",
          // Will arriving from the identity service CREATE an account here?
          //
          // Published because a portal listing this surface has to answer "can
          // you get in", and it was answering "can you sign up". Those were the
          // same question until auto-provision existed. A surface with signup
          // closed and auto-provision on is fully open to anyone holding a
          // verified central account — and was invisible in the portal, because
          // signup_enabled said false and nothing else was on offer to read.
          auto_provision: autoProvisionEnabled(),
          // The account can be made on THIS page (POST /auth/identity/signup), so
          // the page shows a sign-up form rather than sending anyone away to make one.
          signup_on_page: signupOnPageEnabled(),
        }
      : null,
  });
});

// ────────────────────────── POST /signup ─────────────────────────
//
// Gated by PUBLIC_SIGNUP_ENABLED. Off by default in prod so an
// open Funnel/Tailnet URL can't be used to mint workspaces by
// strangers. Existing users still log in via /login or
// /magic/consume; platform admins mint new accounts via
// /super-admin/users.

authRouter.post("/signup", async (req, res, next) => {
  try {
    if (overLimit(signupLimiter, req)) return rateLimited(res);
    // The operator turned password and email-link sign-in off: the
    // instance's own provider is the only way in (platform/oidc.ts).
    if (!(await passwordSignInOn())) return res.status(403).json(PASSWORD_SIGN_IN_OFF);
    const body = SignupBody.parse(req.body);
    const email = body.email.toLowerCase().trim();

    // ── abuse guards ── both no-op unless configured (the trial box turns them
    // on); run before any DB work so a bot never touches the invite/user path.
    const captcha = await captchaVerdict(body.captcha_token ?? undefined, req);
    if (captcha !== "pass") return captchaRefusal(res, captcha);
    if (blockDisposableEnabled() && isDisposableEmail(email)) {
      return res.status(400).json({
        error: { code: "email_not_allowed", message: "Please sign up with a permanent email address." },
      });
    }

    // Authorisation: open if public signup is on, OR this is a managed-app
    // signup on a deployment that's opened the funnel (the consumer product can
    // launch without opening generic platform signup), OR the caller holds a
    // valid single-use signup-invite. Validate (status + email-lock) now; the
    // atomic claim happens just before user creation (race-safe).
    const isManagedAppSignup = !!body.app && managedAppSignupEnabled();
    let invite: { id: string; invited_email: string | null; created_by: string; blueprint: unknown | null } | null = null;
    // A share invite from here or a trusted Cobblr, still good, is the
    // invitation: the owner of a Cobblr this one trusts invited this person.
    const sharedIn = !publicSignupEnabled() && !isManagedAppSignup && !body.invite_token && body.share_invite ? await shareInviteAdmits(body.share_invite, hereUrl(publicOrigin(req))) : false;
    if (!publicSignupEnabled() && !isManagedAppSignup && !body.invite_token && !sharedIn) {
      return res.status(403).json({
        error: {
          code: "signup_disabled",
          message:
            "Public signup is disabled on this deployment. You need an invite link to sign up.",
        },
      });
    }
    // A provided token is honoured REGARDLESS of the public-signup gate: it
    // must be consumed (single-use bookkeeping) and it may carry a premade
    // workspace blueprint that should apply even on an open deployment.
    if (body.invite_token && !isManagedAppSignup) {
      const row = await meta
        .selectFrom("signup_invites")
        .select(["id", "invited_email", "created_by", "expires_at", "consumed_at", "revoked_at", "blueprint"])
        .where("token", "=", body.invite_token)
        .executeTakeFirst();
      const expired = row?.expires_at && new Date(row.expires_at) < new Date();
      if (!row || row.consumed_at || row.revoked_at || expired) {
        return res.status(403).json({
          error: { code: "invite_invalid", message: "This invite link is invalid, already used, or expired." },
        });
      }
      if (row.invited_email && row.invited_email.toLowerCase().trim() !== email) {
        return res.status(403).json({
          error: { code: "invite_email_mismatch", message: `This invite is for ${row.invited_email}.` },
        });
      }
      invite = { id: row.id, invited_email: row.invited_email, created_by: row.created_by, blueprint: row.blueprint ?? null };
    }

    // Cheap existence check before the more expensive bcrypt+insert.
    const existing = await meta
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    if (existing) {
      return res
        .status(409)
        .json({ error: { code: "email_taken", message: "That email is already registered." } });
    }

    // Atomically claim the invite (single-use, race-safe) right before we
    // create the account. If another request beat us to it, the conditional
    // update touches no rows → reject.
    if (invite) {
      const claimed = await meta
        .updateTable("signup_invites")
        .set({ consumed_at: new Date() })
        .where("id", "=", invite.id)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!claimed) {
        return res.status(403).json({
          error: { code: "invite_invalid", message: "This invite link was just used." },
        });
      }
    }

    const password_hash = await hashPassword(body.password);

    // Phase 1: user row only (org provisioning is its own helper now,
    // so signup and POST /orgs share the same code path). The row is born
    // through the one door that also tells the operator (platform/accounts.ts).
    const userId = await createAccount(
      meta,
      { email, password_hash, display_name: body.display_name.trim() },
      { via: "signup", how: invite ? "invite" : isManagedAppSignup ? "app" : "open", ...(isManagedAppSignup ? { app: String(body.app) } : {}) },
    );

    // Attribute the consumed invite to the new user (the claim above only
    // stamped consumed_at, before the user existed).
    if (invite) {
      await meta
        .updateTable("signup_invites")
        .set({ consumed_by_user: userId })
        .where("id", "=", invite.id)
        .execute();
      // Tell the inviter their invitee just signed up. Notifications are
      // org-scoped, so fire it in the inviter's first org → it fans out to their
      // channels (in-app always; Discord/email/etc. if they've added those in
      // notification settings). Best-effort — never block the signup.
      // Reserved/test addresses (…@x.local — demo + e2e accounts) are noise,
      // not news: skip the ping entirely.
      try {
        if (isUndeliverableTestAddress(email)) throw new SkipNotify();
        const inviterOrg = await meta
          .selectFrom("org_memberships")
          .select("org_id")
          .where("user_id", "=", invite.created_by)
          .orderBy("joined_at", "asc")
          .executeTakeFirst();
        if (inviterOrg) {
          await dispatch({
            orgId: inviterOrg.org_id,
            userId: invite.created_by,
            eventType: "platform.invite.accepted",
            message: `${body.display_name.trim()} (${email}) signed up via your invite.`,
            // Straight to the member list: the next thing anyone does after
            // "they joined" is look at who is in the workspace, or set the
            // new person's role.
            // PAGE-LINK: the new member has no record of their own to open;
            // the member list is where you act on them.
            link_url: "/configuration/members",
          });
        }
      } catch (err) {
        if (!(err instanceof SkipNotify)) console.error("[signup] invite-accepted notification failed:", err);
      }
    }

    // Phase 2: provision the user's first org. A managed-app signup ("Cobblr
    // for Yarn") makes that workspace the app itself (bundle + app mode);
    // otherwise it's a generic workspace.
    let provisioned: { orgId: string };
    try {
      provisioned = body.app
        ? await provisionAppWorkspace(userId, body.app, body.manifest, { auth_method: "session" })
        : await provisionOrgForUser(userId, body.org_name ?? `${body.display_name.trim()}'s workspace`);
    } catch (err) {
      if (!(err instanceof WorkspaceNotProvisioned)) throw err;
      // The workspace could not be made and was removed. The account was made a
      // moment ago for it: without the workspace the signup did not happen, so
      // it goes too and the invite is free again. The person tries again with
      // the same address, and nobody is left holding a workspace that 503s.
      await hardDeleteUser(userId).catch((e) => console.error(`[signup] could not undo account ${userId}:`, (e as Error).message));
      if (invite) {
        await meta
          .updateTable("signup_invites")
          .set({ consumed_at: null, consumed_by_user: null })
          .where("id", "=", invite.id)
          .execute()
          .catch((e) => console.error(`[signup] could not release invite ${invite!.id}:`, (e as Error).message));
      }
      return res.status(503).json({ error: { code: err.code, message: WORKSPACE_NOT_CREATED_MESSAGE } });
    }

    await meta.updateTable("orgs").set({ main_currency: currencyFromLocale(req.get("Accept-Language")?.split(",")[0]?.split(";")[0]) }).where("id", "=", provisioned.orgId).execute();
    // Lifecycle seam: the hosted overlay attaches here. No-op in open core.
    await fireSignup({ userId, email, orgId: provisioned.orgId });
    recordSignup({ orgId: provisioned.orgId, userId, via: "form", source: body.source });

    // Premade workspace: the invite carried a blueprint — apply it so the
    // invitee lands in a workspace already configured for them (modules,
    // bundles, fields, views). Best-effort by design: a bad blueprint must
    // never brick a signup; they just get the normal empty workspace.
    let blueprintApplied: { name: string } | null = null;
    if (invite?.blueprint && !body.app) {
      const bp = BlueprintManifest.safeParse(invite.blueprint);
      if (bp.success) {
        try {
          await applyBlueprint(provisioned.orgId, { id: userId, display_name: body.display_name.trim(), auth_method: "session" }, bp.data);
          blueprintApplied = { name: bp.data.name };
        } catch (err) {
          console.error("[signup] invite blueprint apply failed:", err);
        }
      } else {
        console.error("[signup] invite blueprint failed validation:", bp.error.issues.slice(0, 3));
      }
    }

    // Send an email-verification link (best-effort — never blocks signup;
    // no-op delivery when no auth-email sender is configured).
    // DETACHED: an email; the account exists without it, and the sign-in page offers a resend
    void issueAndSendVerifyEmail(userId, email, req).catch((err) =>
      console.error("[signup] verify-email send failed:", err),
    );

    try {
      // user_created lives outside provisionOrgForUser so additional
      // org creations don't fake-log a new user.
      await activity.log({
        orgId: (await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).executeTakeFirstOrThrow()).org_id,
        userId,
        action: "user_created",
        ref: { module: null, entityType: "user", entityId: userId },
        diff: { email },
      });
    } catch (err) {
      console.error("[signup] user_created log failed:", err);
    }

    // Email-verification gate: when required, do NOT auto-login. The verify link
    // was sent above; the user must click it before they can sign in. This is
    // what stops a bot from getting a working session at signup time.
    if (requireEmailVerify()) {
      return res.status(201).json({ needs_verification: true, email });
    }

    const out = await buildAuthResponse(userId);
    return res.status(201).json({ ...out, ...(blueprintApplied ? { blueprint_applied: blueprintApplied } : {}) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: { code: "invalid_body", message: invalidBodyMessage(err.issues), details: err.issues },
      });
    }
    if (err instanceof ProvisionAppError) {
      return res.status(400).json({ error: { code: err.code, message: err.message, details: err.detail } });
    }
    return next(err);
  }
});

// ─────────────────── GET /signup-invite/:token ───────────────────
// Public, no auth: the /join/:token page calls this to render before the
// visitor signs up. Returns the invite's status (+ the email it's locked to,
// if any) without leaking who minted it.
authRouter.get("/signup-invite/:token", async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const row = await meta
      .selectFrom("signup_invites")
      .select(["invited_email", "note", "expires_at", "consumed_at", "revoked_at", "blueprint"])
      .where("token", "=", token)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
      return;
    }
    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    const status = row.revoked_at
      ? "revoked"
      : row.consumed_at
        ? "consumed"
        : expired
          ? "expired"
          : "open";
    const bpName =
      row.blueprint && typeof row.blueprint === "object" && typeof (row.blueprint as { name?: unknown }).name === "string"
        ? (row.blueprint as { name: string }).name
        : null;
    res.json({ status, invited_email: row.invited_email, note: row.note, blueprint_name: bpName });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────── POST /login ──────────────────────────

// Response shape when an account is currently in its lockout window. Generic
// and identical whether or not the email is registered — the counter is bucketed
// by the SUBMITTED email regardless (see auth/lockout.ts + migration 112) — so it
// stays out of the anti-enumeration posture the 401 path already holds.
const ACCOUNT_LOCKED = {
  error: {
    code: "account_locked",
    message: "Too many failed attempts. Try again in a few minutes, or reset your password.",
  },
} as const;

authRouter.post("/login", async (req, res, next) => {
  try {
    if (overLimit(loginLimiter, req)) return rateLimited(res);
    // The operator turned password and email-link sign-in off: the
    // instance's own provider is the only way in (platform/oidc.ts).
    if (!(await passwordSignInOn())) return res.status(403).json(PASSWORD_SIGN_IN_OFF);
    const body = LoginBody.parse(req.body);
    // One field, an email or a username (#6910); `email` is the field's old name.
    const identifier = (body.identifier ?? body.email ?? "").toLowerCase().trim();
    const now = new Date();

    // Same response for "no account" and "wrong password", so it never says
    // which names are registered.
    const denied = () =>
      res.status(401).json({
        error: { code: "invalid_credentials", message: "That email or username and password do not match." },
      });

    // The password and the shared per-account lockout (auth/password-login.ts):
    // whichever name is typed, an account is one bucket, its email.
    const signIn = await attemptPasswordLogin({ identifier, password: body.password, now, limits: !AUTH_LIMITS_OFF });
    if (signIn.outcome === "locked") return res.status(429).json(ACCOUNT_LOCKED);
    if (signIn.outcome === "denied" && signIn.disabled) {
      if (!AUTH_LIMITS_OFF) await recordFailedLogin(signIn.bucket, now);
      return denied();
    }
    if (signIn.outcome === "denied") {
      // The central account. Where one fronts this surface, a person made on
      // the account service (or on this page through it) has no password here
      // at all, so the password is asked of the account service, from this
      // server: the same form, no trip to another site. It knows people by
      // email, so a username is asked only of this server.
      if (identityCallbackEnabled() && signIn.kind === "email") {
        const central = await surfaceAccountCall("login", {
          email: identifier,
          password: body.password,
          clientIp: req.ip ?? "unknown",
          returnTo: callbackReturnTo(pageOrigin(req), { app: body.app ?? null, source: body.source ?? null }),
        });
        if (central.ok && central.token) {
          if (!AUTH_LIMITS_OFF) await clearLoginAttempts(signIn.bucket);
          const out = await completeIdentitySignIn(central.token, body.app, body.source, req.get("Accept-Language")?.split(",")[0]?.split(";")[0]);
          return res.status(out.status).json(out.body);
        }
        if (!central.ok && central.error === "email_unverified") {
          return res.status(403).json({
            error: { code: "email_unverified", message: "Confirm your email first. We just sent you a fresh link." },
          });
        }
        if (!central.ok && central.status === 429) return rateLimited(res);
      }
      if (!AUTH_LIMITS_OFF) await recordFailedLogin(signIn.bucket, now);
      return denied();
    }
    const user = signIn.user;
    const email = user.email;

    // Email-verification gate (trial): deny login until verified, and resend the
    // link so the user has a fresh one. No-op unless COBBLR_REQUIRE_EMAIL_VERIFY.
    // An account made without an email (#6910) has nothing to confirm.
    if (requireEmailVerify() && !user.email_verified_at && !isUndeliverableAddress(email)) {
      // DETACHED: an email; the refusal already says to check for it, and asking again resends
      void issueAndSendVerifyEmail(user.id, email, req).catch((e) =>
        console.error("[login] verify-email resend failed:", e),
      );
      return res.status(403).json({
        error: { code: "email_unverified", message: "Please verify your email first. We just sent you a fresh link." },
      });
    }

    await meta
      .updateTable("users")
      .set({ last_login_at: new Date() })
      .where("id", "=", user.id)
      .execute();

    const out = await buildAuthResponse(user.id);
    return res.json(out);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: { code: "invalid_body", message: invalidBodyMessage(err.issues), details: err.issues },
      });
    }
    return next(err);
  }
});

// ─────────────── POST /identity/exchange (central identity SSO) ───────────────
//
// Slice 3: a caller presents a token minted by the central identity service; this
// surface verifies it against the service's JWKS, maps the global identity to its LOCAL
// user (the id set by the backfill reconcile), and issues a normal local session. The
// surface keeps owning sessions + memberships; the central token only proves *who*.
// 404s when this identity has no linked user here (e.g. never provisioned on this
// surface) — Slice 4's demo-provision is what would create one. No-op unless wired.

const IdentityExchangeBody = z.object({ token: z.string().min(1) });

// ─────────── POST /identity/callback (the browser hand-off's second half) ───────────
//
// The account service sends a browser back here with a ONE-TIME CODE. This trades the
// code for an identity token server-to-server, then hands it to the same verification
// the exchange endpoint uses. Two round trips instead of one, and the reason is that a
// token in a redirect URL lands in browser history, a Referer header, and every proxy
// log on the way; a code is single-use and dead within a minute.
//
// The deployment secret is what makes redemption ours: intercepting the code is not
// enough to redeem it. It never leaves this process.
const IdentityCallbackBody = z.object({
  code: z.string().min(20).max(512),
  // The managed app the person asked for on /start/<app>, carried through the
  // hand-off so a NEW account is provisioned as it. Unknown values are
  // ignored (see identity-provision.ts); a stale link must not strand a sign-in.
  app: z.string().min(1).max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  // The link or QR that sent the person to sign up, carried on return_to the
  // way `app` is. Recorded on a NEW account only; cleaned, never refused.
  source: z.string().max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
});

type AdoptResult =
  | { userId: string; provisioned: { slug: string; app: string | null } | null }
  | { status: number; error: { code: string; message: string } };

const NO_LOCAL_ACCOUNT = {
  status: 404,
  error: { code: "no_local_account", message: "No workspace for this account on this surface." },
} as const;

/** A verified central account arrived and has no user here yet. Decide what that means.
 *
 *  THREE OUTCOMES, and the difference between them matters more than the code:
 *   • adopt   — a local account already exists at this address but was never linked
 *               (it predates central identity, or the backfill has not reached it).
 *               Link it. Creating a second account for the same person would strand
 *               them next to their own data.
 *   • provision — nobody here by that address, and this surface hands workspaces out.
 *   • refuse  — anything else, including a surface that does not hand them out.
 *
 *  EVERY path requires a VERIFIED address, adoption most of all: without that check,
 *  registering someone else's email at the account service and never confirming it
 *  would take over their workspace here. The account service is the only thing that
 *  knows whether the address was proven, so this asks it rather than assuming. */
async function adoptOrProvisionIdentity(
  identityId: string,
  identityToken: string,
  app?: string,
  source?: string,
  locale?: string,
): Promise<AdoptResult> {
  const profile = await fetchIdentityProfile(identityToken);
  if (!profile) return NO_LOCAL_ACCOUNT;
  if (!profile.emailVerified) {
    return {
      status: 403,
      error: { code: "email_unverified", message: `Confirm your email address on your ${productName()} account first.` },
    };
  }

  const byEmail = await meta
    .selectFrom("users")
    .select(["id", "active", "identity_id"])
    .where("email", "=", profile.email)
    .executeTakeFirst();
  if (byEmail) {
    if (!byEmail.active) {
      return { status: 403, error: { code: "account_disabled", message: "This account is disabled on this surface." } };
    }
    // Already someone else's identity. Not an error to explain in detail — it means two
    // central accounts claim one address here, and quietly re-pointing the link would
    // hand one person the other's workspace.
    if (byEmail.identity_id && byEmail.identity_id !== identityId) return NO_LOCAL_ACCOUNT;
    await meta.updateTable("users").set({ identity_id: identityId }).where("id", "=", byEmail.id).execute();
    // Adopted as it is, whatever app the link named (planIdentityWorkspace).
    return { userId: byEmail.id, provisioned: null };
  }

  if (!autoProvisionEnabled()) return NO_LOCAL_ACCOUNT;
  if (blockDisposableEnabled() && isDisposableEmail(profile.email)) {
    return {
      status: 403,
      error: { code: "email_not_allowed", message: "Please use a permanent email address." },
    };
  }

  // The column is NOT NULL and this account has no password to store, so it gets a hash
  // of 32 random bytes: nothing anyone can type will ever match it. A sentinel string
  // would have to be excluded by every comparison site forever, which is one forgotten
  // call site away from a login that succeeds on a fake password.
  const password_hash = await hashPassword(randomBytes(32).toString("base64"));
  const created = {
    id: await createAccount(
      meta,
      { email: profile.email, password_hash, display_name: profile.displayName, identity_id: identityId, email_verified_at: new Date() },
      { via: "identity" },
    ),
  };

  // The fourth create path agrees with the other three: asked for from
  // /start/<app>, a new account's first workspace IS the app, the way the
  // signup form's app branch does it. Otherwise the plain workspace as before.
  const plan = planIdentityWorkspace({ existing: false, app, isKnownApp: (id) => getManagedApp(id) !== null });
  let wantApp = plan.kind === "provision" ? plan.app : null;
  let provisioned: { orgId: string; slug: string } | null = null;
  if (wantApp) {
    try {
      provisioned = await provisionAppWorkspace(created.id, wantApp, undefined, { auth_method: "session" });
    } catch (err) {
      // The bundle could not be resolved right now. The sign-in still has to
      // succeed: the account exists already, so the person gets a plain
      // workspace and can add the app from inside it.
      if (!(err instanceof ProvisionAppError)) throw err;
      console.warn(`[identity] ${wantApp} app unavailable (${err.code}); provisioning a plain workspace instead`);
      wantApp = null;
    }
  }
  provisioned ??= await provisionOrgForUser(created.id, `${profile.displayName}'s workspace`);
  await meta.updateTable("orgs").set({ main_currency: currencyFromLocale(locale) }).where("id", "=", provisioned.orgId).execute();
  // Same lifecycle seam signup uses, so the hosted overlay sees these accounts too
  // (trial stamping, welcome flows) rather than only the ones that came through a form.
  await fireSignup({ userId: created.id, email: profile.email, orgId: provisioned.orgId });
  recordSignup({ orgId: provisioned.orgId, userId: created.id, via: "identity", source });
  try {
    await activity.log({
      orgId: provisioned.orgId,
      userId: created.id,
      action: "user_created",
      ref: { module: null, entityType: "user", entityId: created.id },
      diff: { email: profile.email, via: "central_identity" },
    });
  } catch (err) {
    console.error("[identity] user_created log failed:", err);
  }
  console.log(`[identity] provisioned ${wantApp ? `the ${wantApp} app` : "a workspace"} for a central account (${created.id})`);
  return { userId: created.id, provisioned: { slug: provisioned.slug, app: wantApp } };
}

// POST /auth/identity/deleted — the account service says an identity is gone.
// Server to server, proven with the deployment secret (the one this surface
// redeems codes with), so nobody else can delete an account by naming its id.
// The local user linked to that identity is deleted the way the person asked
// upstream: with the workspaces they solely owned, since "delete my account"
// there said so. Idempotent: an identity this surface never met, or already
// removed, is a 204. Without this a deletion on one side left the other, and
// an orphan identity-linked user was handed a fresh workspace on the next
// hand-off (#3276).
const IdentityDeletedBody = z.object({ identity_id: z.string().uuid(), secret: z.string().min(1) });
// UI-REACH: the identity service telling this instance an account is gone, server to server
authRouter.post("/identity/deleted", async (req, res, next) => {
  try {
    if (!identityCallbackEnabled()) {
      return res.status(404).json({ error: { code: "identity_disabled", message: "Central identity is not enabled on this surface." } });
    }
    if (!identityExchangeLimiter(req.ip ?? "unknown")) {
      return rateLimited(res);
    }
    const parsed = IdentityDeletedBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: "invalid_body", message: "identity_id and secret are required." } });
    }
    if (!deploymentSecretMatches(parsed.data.secret)) {
      return res.status(401).json({ error: { code: "bad_secret", message: "Not the account service." } });
    }
    const user = await meta.selectFrom("users").select("id").where("identity_id", "=", parsed.data.identity_id).executeTakeFirst();
    if (user) {
      const result = await hardDeleteUser(user.id, { deleteSoleOwnedWorkspaces: true });
      console.log(`[identity/deleted] account ${user.id} ${result.mode} (identity ${parsed.data.identity_id}${result.workspaces_deleted.length ? `, with ${result.workspaces_deleted.map((w) => w.slug).join(", ")}` : ""})`);
    }
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/** A verified central account, signed in here: the linked user, or the one this
 *  surface adopts or makes for it (adoptOrProvisionIdentity). Shared by every door
 *  a central account comes through: the hand-off's code, and the password typed
 *  on this surface's own form. */
async function completeIdentitySignIn(
  identityToken: string,
  app?: string,
  source?: string,
  locale?: string,
): Promise<{ status: number; body: unknown }> {
  let identityId: string;
  try {
    identityId = await verifyIdentityToken(identityToken);
  } catch {
    // The account service handed us something we cannot verify. That is a
    // configuration fault (issuer, audience, or a rotated key), not a bad user.
    return {
      status: 502,
      body: { error: { code: "identity_token_invalid", message: "The account service returned a token this surface cannot verify." } },
    };
  }
  const linked = await meta
    .selectFrom("users")
    .select(["id", "active"])
    .where("identity_id", "=", identityId)
    .executeTakeFirst();
  // A disabled account is a decision somebody made, so it stops here rather than
  // falling through to the path that would hand it a fresh workspace.
  if (linked && !linked.active) {
    return { status: 403, body: { error: { code: "account_disabled", message: "This account is disabled on this surface." } } };
  }
  let userId = linked?.id;
  let provisioned: { slug: string; app: string | null } | null = null;
  if (!userId) {
    const outcome = await adoptOrProvisionIdentity(identityId, identityToken, app, source, locale);
    if ("error" in outcome) return { status: outcome.status, body: { error: outcome.error } };
    userId = outcome.userId;
    provisioned = outcome.provisioned;
  }
  await meta.updateTable("users").set({ last_login_at: new Date() }).where("id", "=", userId).execute();
  // `provisioned` says what THIS sign-in made, so the page can land the person
  // in the app they asked for rather than on the generic home.
  return { status: 200, body: { ...(await buildAuthResponse(userId)), provisioned } };
}

/** The origin the page was opened on, for the address a confirmation link comes
 *  back to. PUBLIC_BASE_URL when set; otherwise what the browser said it was on.
 *  Either way the account service only sends people to an origin on its own
 *  allow-list, so a forged header can name nowhere new. */
function pageOrigin(req: { get(name: string): string | undefined }): string {
  const configured = publicBaseUrl();
  if (configured) return configured;
  const origin = req.get("origin") ?? "";
  return /^https?:\/\/[^/\s]+$/.test(origin) ? origin : "";
}

// ─────────── POST /identity/signup (the account, made on this page) ───────────
//
// A person making their Cobblr account types their name, email and password HERE.
// The account is still the central one: this surface asks the account service to
// make it (its /surface/signup, proven with this surface's deployment secret) and
// to email the confirmation link. That link brings them back through the hand-off
// to /auth/callback, signed in, with the app and source this page was opened with.
// The trip to the account service's own site is what goes, not the account.
//
// The page's captcha is checked here, where its widget ran; the account service
// cannot verify a token issued for this site's key. Same answer whatever is true
// ("check your email"), as the account service's own signup.
const IdentitySignupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().trim().min(1).max(120),
  captcha_token: optionalText(4096),
  app: z.string().min(1).max(40).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  source: z.string().max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  /** The form says, beside Create account, that making the account agrees to
   *  the account's terms (linked). True records that agreement with the account
   *  service, so confirming the address does not stop on a terms page. */
  accept_terms: z.boolean().optional(),
});

authRouter.post("/identity/signup", async (req, res, next) => {
  try {
    if (!signupOnPageEnabled()) {
      return res.status(404).json({
        error: { code: "identity_signup_disabled", message: "Accounts are not made on this page here." },
      });
    }
    if (overLimit(signupLimiter, req)) return rateLimited(res);
    const body = IdentitySignupBody.parse(req.body);
    const email = body.email.toLowerCase().trim();
    const captcha = await captchaVerdict(body.captcha_token ?? undefined, req);
    if (captcha !== "pass") return captchaRefusal(res, captcha);
    if (blockDisposableEnabled() && isDisposableEmail(email)) {
      return res.status(400).json({
        error: { code: "email_not_allowed", message: "Please sign up with a permanent email address." },
      });
    }
    const reply = await surfaceAccountCall("signup", {
      email,
      password: body.password,
      displayName: body.display_name,
      acceptTerms: body.accept_terms ? await currentAccountTerms() : null,
      clientIp: req.ip ?? "unknown",
      returnTo: callbackReturnTo(pageOrigin(req), { app: body.app ?? null, source: body.source ?? null }),
    });
    if (reply.ok) return res.status(202).json({ status: "check_your_email" });
    if (reply.status === 429) return rateLimited(res);
    const said: Record<string, string> = {
      bad_email: "That email address does not look right.",
      weak_password: "Use a password of at least 8 characters.",
      name_required: "Say what to call you.",
    };
    if (said[reply.error]) return res.status(400).json({ error: { code: reply.error, message: said[reply.error] } });
    console.error(`[identity/signup] the account service answered ${reply.status} ${reply.error}`);
    return res.status(502).json({
      error: { code: "identity_unavailable", message: "Accounts cannot be made right now. Try again in a minute." },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { code: "invalid_body", message: "Name, email and a password of 8 or more characters, please.", details: err.issues } });
    }
    return next(err);
  }
});

authRouter.post("/identity/callback", async (req, res, next) => {
  try {
    if (!identityCallbackEnabled()) {
      return res.status(404).json({
        error: { code: "identity_disabled", message: "Central identity is not enabled on this surface." },
      });
    }
    if (!identityExchangeLimiter(req.ip ?? "unknown")) {
      return rateLimited(res);
    }
    const { code, app, source } = IdentityCallbackBody.parse(req.body);
    const redeemed = await redeemIdentityCode(code);
    if (!redeemed) {
      return res.status(401).json({
        error: { code: "invalid_code", message: "That sign-in link has expired or was already used." },
      });
    }
    const out = await completeIdentitySignIn(redeemed, app, source, req.get("Accept-Language")?.split(",")[0]?.split(";")[0]);
    return res.status(out.status).json(out.body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(err.issues), details: err.issues } });
    }
    return next(err);
  }
});

// UI-REACH: token exchange for identity clients; browser sign-in uses /identity/callback.
authRouter.post("/identity/exchange", async (req, res, next) => {
  try {
    if (!identityEnabled()) {
      return res.status(404).json({ error: { code: "identity_disabled", message: "Central identity is not enabled on this surface." } });
    }
    // Unauthenticated + does a jwtVerify and a users lookup — cap bursts (token probing /
    // identity enumeration / CPU) like every other auth endpoint here.
    if (!identityExchangeLimiter(req.ip ?? "unknown")) {
      return rateLimited(res);
    }
    const { token } = IdentityExchangeBody.parse(req.body);
    let identityId: string;
    try {
      identityId = await verifyIdentityToken(token);
    } catch {
      return res.status(401).json({ error: { code: "invalid_identity_token", message: "Identity token is invalid or expired." } });
    }
    const user = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("identity_id", "=", identityId)
      .executeTakeFirst();
    if (!user || !user.active) {
      return res.status(404).json({ error: { code: "no_local_account", message: "No workspace for this account on this surface." } });
    }
    await meta.updateTable("users").set({ last_login_at: new Date() }).where("id", "=", user.id).execute();
    return res.json(await buildAuthResponse(user.id));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(err.issues), details: err.issues } });
    }
    return next(err);
  }
});

// ──────────────────────── Magic-link auth ───────────────────────────
//
// Passwordless login. The flow:
//
//   1. POST /auth/magic/request {email}
//        creates a one-time, 15min-bounded token. The plaintext is
//        returned ONCE in the response (dev mode) so the front-end
//        can show the user a copy-link button. In production this
//        would arrive via email instead — Cobblr core doesn't ship
//        SMTP; modules can subscribe to the auth.magic.requested
//        event to wire one up.
//
//   2. POST /auth/magic/consume {token}
//        verifies the token (unconsumed, unexpired), marks it
//        consumed, signs a session JWT, returns the full auth
//        response. Works whether or not the user existed before —
//        if no row for the email exists, a fresh user is created
//        with that email and a placeholder display name.
//
// Security notes:
//   - Tokens are stored as sha256 hashes; plaintext only ever
//     transits the request once.
//   - 15min TTL is short enough that bruteforcing is impractical
//     with a 256-bit URL-safe random token.
//   - Single-use: consumed_at is set on first redeem; re-redeems
//     return 410. No retry budget.
//   - We don't disclose whether the email was previously registered
//     — same 202 response either way — to avoid email-enumeration.

import { createHash, randomBytes } from "node:crypto";
import {
  MAGIC_TTL_MS,
  hashMagicToken,
  issueSignInLink,
} from "../platform/sign-in-link.js";
import { revokeSandboxLinksForUser } from "../platform/try-sandbox.js";
import { inviteStatus, joinThroughInvite, REFUSAL } from "../platform/join-invite.js";
import { publicBaseUrl } from "@cobblr/platform-contract/public-url";
import { hashPairCode, mintPairCode, pairMintRefusal, PAIR_CODE_TTL_MS } from "../platform/pair-codes.js";
import { vapidKeys } from "../platform/push-keys.js";
import { optionalField, optionalText } from "@cobblr/platform-contract/optional-fields";
import { invalidBodyMessage } from "@cobblr/platform-contract/invalid-body";

/** True when this instance has its Web Push key pair, false when it has none,
 *  null when the answer could not be read (said in the log, never a false). */
async function webPushReady(): Promise<boolean | null> {
  try {
    return (await vapidKeys()) !== null;
  } catch (err) {
    console.error("[push] could not read the Web Push key for /auth/config:", err instanceof Error ? err.message : err);
    return null;
  }
}


/** A page on this site to come back to: a path, never another origin. */
const NextPath = z
  .string()
  .max(500)
  .regex(/^\/(?![\/\\])[^\s]*$/, "next must be a path on this site");

const MagicRequest = z.object({
  email: z.string().email().max(255),
  /** Where they asked from (the item they scanned); the link lands there. */
  next: NextPath.optional(),
  /** A workspace invite the link redeems as it signs in: how someone with
   *  no password joins through the club's join link (#3801). */
  invite: z.string().min(8).max(200).optional(),
  /** The name a new account made through the invite goes by. */
  display_name: z.string().trim().min(1).max(120).optional(),
});

authRouter.post("/magic/request", async (req, res, next) => {
  try {
    if (overLimit(magicRequestLimiter, req)) return rateLimited(res);
    // The operator turned password and email-link sign-in off: the
    // instance's own provider is the only way in (platform/oidc.ts).
    if (!(await passwordSignInOn())) return res.status(403).json(PASSWORD_SIGN_IN_OFF);
    const parsed = MagicRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues },
      });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();

    // Invite-only gate at request time: only issue a link if the email can
    // actually sign in — an existing user, a platform admin (bootstrap), or when
    // public signup is open. Otherwise return the SAME 202 (no enumeration) but
    // send nothing, so a non-invited address never gets a usable sign-in email.
    // (consume is gated too — defense in depth.)
    const existingForLink = await meta
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    // An open invite is standing to sign up, the same as the invite page's
    // own form: it authorises one new account into that workspace. Refused
    // in words (it is the invite's holder asking, not an enumeration probe).
    let viaInvite: { token: string; org_name: string } | null = null;
    if (parsed.data.invite) {
      const invite = await meta
        .selectFrom("workspace_invites as i")
        .innerJoin("orgs as o", "o.id", "i.org_id")
        .select(["i.id", "i.token", "i.invited_email", "i.revoked_at", "i.consumed_at", "i.expires_at", "i.reusable", "i.max_uses", "i.use_count", "i.paused_at", "o.name as org_name"])
        .where("i.token", "=", parsed.data.invite)
        .executeTakeFirst();
      if (!invite) {
        res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
        return;
      }
      const status = inviteStatus(invite);
      if (status !== "open") {
        res.status(410).json({ error: { code: status, message: REFUSAL[status] } });
        return;
      }
      if (invite.invited_email && invite.invited_email.toLowerCase().trim() !== email) {
        res.status(403).json({ error: { code: "invite_email_mismatch", message: `This invite is for ${invite.invited_email}.` } });
        return;
      }
      viaInvite = { token: invite.token, org_name: invite.org_name };
    }
    if (!existingForLink && !viaInvite && !isPlatformAdmin(email) && !publicSignupEnabled()) {
      res.status(202).json({
        ok: true,
        expires_at: new Date(Date.now() + MAGIC_TTL_MS).toISOString(),
        message: "If that email exists or is allowed to sign in, a magic link has been issued.",
      });
      return;
    }


    // Dev mode: return the plaintext + a copy-paste-able URL so the
    // demo flow works without SMTP. A production env that wires
    // email delivery (via an auth.magic.requested event subscriber
    // in a future module) should set NODE_ENV=production AND the
    // requester won't see the link in the response.
    const issued = await issueSignInLink({
      email,
      absBase: linkOrigin(req),
      requestIp: req.ip ?? null,
      requestUa: req.get("user-agent") ?? null,
      ...(viaInvite
        ? { subject: `Join "${viaInvite.org_name}" on ${productName()}`, intro: `Open this to join "${viaInvite.org_name}":` }
        : {}),
      nextPath: parsed.data.next ?? null,
      inviteToken: viaInvite?.token ?? null,
      displayName: viaInvite ? (parsed.data.display_name ?? null) : null,
    });
    const plain = issued.plain;
    const link = issued.path;
    // Deliver via the registered auth-email sender (a self-hoster's SMTP/API or
    // the managed overlay) when one exists. No sender → fall back to the inline
    // dev link below. This is the seam that turns magic-link from a dev-only
    // affordance into a real prod flow.
    const emailed = issued.sent;
    res.status(202).json({
      ok: true,
      // Expose the link inline ONLY when we couldn't email it (dev / no sender),
      // so a prod instance with a sender never leaks it in the response.
      ...(!emailed && process.env.NODE_ENV !== "production" && { dev_token: plain, dev_link: link }),
      expires_at: new Date(Date.now() + MAGIC_TTL_MS).toISOString(),
      message:
        "If that email exists or is allowed to sign in, a magic link has been issued.",
    });
  } catch (err) {
    return next(err);
  }
});

const MagicConsume = z.object({
  token: z.string().min(8).max(200),
});

authRouter.post("/magic/consume", async (req, res, next) => {
  try {
    if (overLimit(magicConsumeLimiter, req)) return rateLimited(res);
    const parsed = MagicConsume.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues },
      });
      return;
    }
    const hash = hashMagicToken(parsed.data.token);
    const row = await meta
      .selectFrom("auth_magic_tokens")
      .selectAll()
      .where("token_hash", "=", hash)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({
        error: { code: "invalid_token", message: "Token not found." },
      });
      return;
    }
    if (row.consumed_at) {
      res.status(410).json({
        error: { code: "already_consumed", message: "Token already used." },
      });
      return;
    }
    if (row.expires_at <= new Date()) {
      res.status(410).json({
        error: { code: "expired", message: "Token has expired." },
      });
      return;
    }
    await meta
      .updateTable("auth_magic_tokens")
      .set({ consumed_at: new Date() })
      .where("id", "=", row.id)
      .execute();

    // Find-or-create the user for this email. If they're new, we
    // also provision a default workspace so the post-login flow has
    // somewhere to land, unless the link joins them to one.
    const existing = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("email", "=", row.email)
      .executeTakeFirst();
    // The invite this link redeems, read again now: it may have filled up or
    // been revoked while the email was in flight, and a new account must not
    // be made for a door that has since closed.
    const invite = row.invite_token
      ? await meta.selectFrom("workspace_invites").selectAll().where("token", "=", row.invite_token).executeTakeFirst()
      : undefined;
    if (row.invite_token && (!invite || (!existing && inviteStatus(invite) !== "open"))) {
      const status = invite ? inviteStatus(invite) : "revoked";
      res.status(410).json({
        error: { code: status, message: status === "open" ? REFUSAL.revoked : REFUSAL[status] },
      });
      return;
    }

    let userId: string;
    if (existing) {
      if (!existing.active) {
        res.status(403).json({
          error: { code: "user_inactive", message: "Account is disabled." },
        });
        return;
      }
      userId = existing.id;
    } else {
      // Invite-only gate: a magic link is NOT a signup backdoor. Only mint a
      // fresh account if public signup is open, OR the email is a platform admin
      // (the operator's own first-login bootstrap). Everyone else must join via
      // an invite (/join/:token) — which collects their workspace name properly.
      if (!invite && !publicSignupEnabled() && !isPlatformAdmin(row.email)) {
        res.status(403).json({
          error: {
            code: "signup_closed",
            message: "Sign-in links work for existing accounts. To create one, you'll need an invite.",
          },
        });
        return;
      }
      // Fresh user via magic link — no password set (they'll always
      // be magic-only unless they later use POST /me/password).
      // Display name defaults to the email's local-part.
      const defaultName = row.display_name || (row.email.split("@")[0] ?? "user");
      userId = await createAccount(
        meta,
        {
          email: row.email,
          password_hash: "", // empty; verifyPassword will reject all
          display_name: defaultName,
          // Clicking the magic link proves control of the email → verified.
          email_verified_at: new Date(),
        },
        { via: "magic-link" },
      );
      // Give them a starter workspace named after them, unless they came to
      // join one: the club member gets the club, not an empty workspace of
      // their own beside it.
      if (!invite) {
        try {
          await provisionOrgForUser(userId, `${defaultName}'s workspace`);
        } catch (err) {
          console.error("[magic/consume] org provision failed:", err);
        }
      }
    }

    let joinedSlug: string | null = null;
    if (invite) {
      const joined = await joinThroughInvite(invite, userId, { newAccount: !existing });
      if (!joined.ok) {
        res.status(410).json({ error: { code: joined.code, message: joined.message } });
        return;
      }
      joinedSlug =
        (await meta.selectFrom("orgs").select("slug").where("id", "=", joined.orgId).executeTakeFirst())?.slug ?? null;
    }

    await meta
      .updateTable("users")
      .set({ last_login_at: new Date() })
      .where("id", "=", userId)
      .execute();
    // They are in through the front door, so a sandbox link they still hold has
    // done its job and stops working now. This is the closing half of the grace
    // window keepSandbox opens: the anonymous URL survives the upgrade only
    // until a real sign-in happens, so nobody is stranded between the two while
    // an email is in flight. Anyone who never had a sandbox matches no rows.
    await revokeSandboxLinksForUser(userId)
      .then((n) => {
        if (n > 0) console.log(`[magic/consume] closed ${n} sandbox link(s) for ${userId}`);
      })
      .catch((err) => console.error("[magic] sandbox link close failed:", err));
    await activity.log({
      orgId: (
        await meta
          .selectFrom("org_memberships")
          .select("org_id")
          .where("user_id", "=", userId)
          .executeTakeFirstOrThrow()
      ).org_id,
      userId,
      action: "login",
      ref: { module: null, entityType: "user", entityId: userId },
      diff: { method: "magic_link" },
    }).catch((err) => console.error("[magic] activity log failed:", err));
    const out = await buildAuthResponse(userId);
    // Back to the page they asked from (the item they scanned), else into the
    // workspace the link joined them to.
    return res.json({ ...out, next: row.next_path ?? (joinedSlug ? `/w/${joinedSlug}` : null) });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════ Password reset + email verification ═══════════════════
//
// Both deliver their link through the auth-email seam (a self-hoster's BYO
// sender or the cloud overlay's managed one). With no sender, the link is
// returned inline in non-prod (dev_link) so the flow is exercisable locally;
// a prod instance with no sender simply can't complete these (by design).
//
// Tokens are stored HASHED (sha256). Lookups are by hash; single-use via
// consumed_at; time-bounded via expires_at.

function hashToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}
function mintToken(): { plain: string; hash: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashToken(plain) };
}

// ───────────────── POST /auth/password/forgot ─────────────────
// Issues a reset link for an existing, active account. ALWAYS returns the same
// 202 regardless of whether the email exists, so it can't be used to enumerate
// registered emails.
const PasswordForgot = z.object({ email: z.string().email().max(255) });

authRouter.post("/password/forgot", async (req, res, next) => {
  try {
    if (!(await passwordSignInOn())) return void res.status(403).json(PASSWORD_SIGN_IN_OFF);
    if (overLimit(passwordForgotLimiter, req)) {
      rateLimited(res);
      return;
    }
    const parsed = PasswordForgot.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const user = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("email", "=", email)
      .executeTakeFirst();

    let devToken: string | undefined;
    if (user && user.active) {
      const { plain, hash } = mintToken();
      // A new link supersedes any outstanding one: only the newest unconsumed
      // token stays live (audit L-INVITE). Marking priors consumed means an
      // older email sitting in an inbox can no longer reset the account.
      await meta
        .updateTable("auth_password_reset_tokens")
        .set({ consumed_at: new Date() })
        .where("user_id", "=", user.id)
        .where("consumed_at", "is", null)
        .execute();
      await meta
        .insertInto("auth_password_reset_tokens")
        .values({
          user_id: user.id,
          token_hash: hash,
          request_ip: (req.ip ?? null) as string | null,
          request_ua: (req.get("user-agent") ?? null) as string | null,
        })
        .execute();
      const absLink = `${linkOrigin(req)}/reset/${plain}`;
      const emailed = await sendAuthEmail({
        to: email,
        subject: `Reset your ${productName()} password`,
        text:
          `Someone asked to reset your ${productName()} password. Open this link to choose a new one:\n\n${absLink}\n\n` +
          `This link expires in 1 hour. If you didn't request it, you can safely ignore this email — your password won't change.`,
        kind: "password_reset",
      });
      if (!emailed && process.env.NODE_ENV !== "production") devToken = plain;
    }

    res.status(202).json({
      ok: true,
      message: "If that email is registered, a password-reset link has been sent.",
      ...(devToken && { dev_token: devToken, dev_link: `/reset/${devToken}` }),
    });
  } catch (err) {
    next(err);
  }
});

// ───────────────── POST /auth/password/reset ─────────────────
// Consumes a reset token + sets the new password. Auto-logs-in on success.
const PasswordReset = z.object({
  token: z.string().min(8).max(200),
  password: z.string().min(8).max(200),
});

authRouter.post("/password/reset", async (req, res, next) => {
  try {
    if (overLimit(passwordResetLimiter, req)) return rateLimited(res);
    const parsed = PasswordReset.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const hash = hashToken(parsed.data.token);
    const row = await meta
      .selectFrom("auth_password_reset_tokens")
      .selectAll()
      .where("token_hash", "=", hash)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "invalid_token", message: "This reset link is invalid." } });
      return;
    }
    if (row.consumed_at) {
      res.status(410).json({ error: { code: "already_consumed", message: "This reset link was already used." } });
      return;
    }
    if (row.expires_at <= new Date()) {
      res.status(410).json({ error: { code: "expired", message: "This reset link has expired." } });
      return;
    }
    const user = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    if (!user || !user.active) {
      res.status(403).json({ error: { code: "user_inactive", message: "This account is disabled." } });
      return;
    }

    const newHash = await hashPassword(parsed.data.password);
    const changed = await meta.transaction().execute(async (trx) => {
      const at = new Date();
      const claimed = await trx
        .updateTable("auth_password_reset_tokens")
        .set({ consumed_at: at })
        .where("id", "=", row.id)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", at)
        .returning("id")
        .executeTakeFirst();
      if (!claimed) return false;
      await trx
        .updateTable("users")
        .set({ password_hash: newHash, must_reset_password: false, tokens_valid_from: at })
        .where("id", "=", row.user_id)
        .execute();
      return true;
    });
    if (!changed) {
      const current = await meta.selectFrom("auth_password_reset_tokens")
        .select(["consumed_at", "expires_at"]).where("id", "=", row.id).executeTakeFirst();
      const expired = current && !current.consumed_at && current.expires_at <= new Date();
      res.status(410).json({ error: expired
        ? { code: "expired", message: "This reset link has expired." }
        : { code: "already_consumed", message: "This reset link was already used." } });
      return;
    }

    const firstOrg = await meta
      .selectFrom("org_memberships")
      .select("org_id")
      .where("user_id", "=", row.user_id)
      .limit(1)
      .executeTakeFirst();
    if (firstOrg) {
      await activity
        .log({
          orgId: firstOrg.org_id,
          userId: row.user_id,
          action: "password_reset",
          ref: { module: null, entityType: "user", entityId: row.user_id },
        })
        .catch((err) => console.error("[password/reset] activity log failed:", err));
    }

    const out = await buildAuthResponse(row.user_id);
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

// ───────────────── Email verification ─────────────────
/** Mint + send an email-verification link for a user. Best-effort; returns
 *  whether it was emailed (false → no sender) and, in non-prod, the dev token
 *  so the flow is testable without delivery. Used by signup + the authed
 *  resend endpoint (me.ts). */
export async function issueAndSendVerifyEmail(
  userId: string,
  email: string,
  req: Request,
): Promise<{ emailed: boolean; devToken?: string }> {
  const normalized = email.toLowerCase().trim();
  const { plain, hash } = mintToken();
  await meta
    .insertInto("auth_email_verify_tokens")
    .values({
      user_id: userId,
      email: normalized,
      token_hash: hash,
      request_ip: (req.ip ?? null) as string | null,
      request_ua: (req.get("user-agent") ?? null) as string | null,
    })
    .execute();
  const absLink = `${linkOrigin(req)}/verify/${plain}`;
  const emailed = await sendAuthEmail({
    to: normalized,
    subject: `Verify your ${productName()} email`,
    text:
      `Confirm your email to finish setting up your ${productName()} account:\n\n${absLink}\n\n` +
      `This link expires in 24 hours. If you didn't create ${withArticle(productName())} account, you can ignore this email.`,
    kind: "verify_email",
  });
  return { emailed, devToken: !emailed && process.env.NODE_ENV !== "production" ? plain : undefined };
}

// ───────────────── POST /auth/email-change/confirm | /revert ─────────────────
// Public: the token in the link is the proof (platform/email-change.ts).
// confirm, from the NEW address, makes the change and ends every session;
// revert, from the OLD address for 7 days, takes the account back and asks
// for a new password. Neither signs anybody in: the person signs in again.
const EmailChangeToken = z.object({ token: z.string().min(8).max(200) });
for (const [path, act] of [
  ["/email-change/confirm", "confirm"],
  ["/email-change/revert", "revert"],
] as const) {
  // AI-REACH: exempt: a link a person opens from their own mailbox.
  authRouter.post(path, async (req, res, next) => {
    try {
      if (overLimit(verifyEmailLimiter, req)) {
        rateLimited(res);
        return;
      }
      const parsed = EmailChangeToken.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "The link is incomplete." } });
        return;
      }
      const origin = linkOrigin(req);
      const out = act === "confirm" ? await confirmEmailChange(parsed.data.token, origin) : await revertEmailChange(parsed.data.token);
      if ("refused" in out) {
        res.status(out.refused.status).json({ error: { code: out.refused.code, message: out.refused.message } });
        return;
      }
      const dev = "revertDevToken" in out && out.revertDevToken ? { dev_revert_token: out.revertDevToken } : {};
      // Undo hands the old mailbox's holder the reset that sets the new
      // password: the page takes them straight to it.
      const reset = "resetToken" in out ? { reset_token: out.resetToken } : {};
      res.json({ email: out.email, ...dev, ...reset });
    } catch (err) {
      next(err);
    }
  });
}

// ───────────────── POST /auth/verify-email ─────────────────
// Public: consumes a verification token + marks the user's email verified.
const VerifyEmail = z.object({ token: z.string().min(8).max(200) });

// UI-SCREEN: /verify/:token (the emailed verification link consumes its token)
authRouter.post("/verify-email", async (req, res, next) => {
  try {
    if (overLimit(verifyEmailLimiter, req)) {
      rateLimited(res);
      return;
    }
    const parsed = VerifyEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: invalidBodyMessage(parsed.error.issues), details: parsed.error.issues } });
      return;
    }
    const hash = hashToken(parsed.data.token);
    const row = await meta
      .selectFrom("auth_email_verify_tokens")
      .selectAll()
      .where("token_hash", "=", hash)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "invalid_token", message: "This verification link is invalid." } });
      return;
    }
    if (row.consumed_at) {
      res.status(410).json({ error: { code: "already_consumed", message: "This link was already used." } });
      return;
    }
    if (row.expires_at <= new Date()) {
      res.status(410).json({ error: { code: "expired", message: "This verification link has expired." } });
      return;
    }
    await meta.updateTable("auth_email_verify_tokens").set({ consumed_at: new Date() }).where("id", "=", row.id).execute();
    // Only mark verified if the user's current email still matches the token's
    // (guards a stale token after an email change).
    await meta
      .updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("id", "=", row.user_id)
      .where("email", "=", row.email)
      .execute();
    res.json({ ok: true, email: row.email });
  } catch (err) {
    next(err);
  }
});

// ─────────────── POST /auth/discord/verify-dm (Feature 1) ───────────────
// Public, token-guarded: the Discord bot calls this when a user clicks the
// "Yes, I got this 👋" button on their test DM. The verify_token IS the secret
// (single-use, short-lived) — same trust model as a magic link — so no session
// is needed. Marks the matching discord_connection verified, enabling the
// discord_dm channel.
const VerifyDmBody = z.object({ token: z.string().min(10).max(255) });

// UI-REACH: the Discord bot confirming a test DM was received
authRouter.post("/discord/verify-dm", async (req, res, next) => {
  try {
    const parsed = VerifyDmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad token" } });
      return;
    }
    const row = await meta
      .selectFrom("discord_connections")
      .select(["user_id", "verify_expires_at"])
      .where("verify_token", "=", parsed.data.token)
      .executeTakeFirst();
    if (!row || (row.verify_expires_at && row.verify_expires_at.getTime() < Date.now())) {
      res.status(410).json({ error: { code: "expired", message: "This confirmation expired or was already used." } });
      return;
    }
    await meta
      .updateTable("discord_connections")
      // Stamp WHICH app proved it. The test DM that just landed came from the
      // configured bot, and that is exactly the fact worth recording: point the
      // server at a different app later and this stops matching, which is what
      // turns a silent dead channel into one re-confirmation.
      .set({
        verified: true,
        verified_app_id: discordAppId(),
        verify_token: null,
        verify_expires_at: null,
        updated_at: new Date(),
      })
      .where("verify_token", "=", parsed.data.token)
      .execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════ QR pair-login (desktop → phone) ═══════════════════════
//
// Built for Cobblr's multi-tenant model. Pattern
// matches WhatsApp Web / Discord device-pairing:
//
//   1. A logged-in DESKTOP (no camera) calls POST /auth/pair/start { org_slug }.
//      Server mints a 128-bit single-use code with a ~5-minute expiry, stores it
//      HASHED, and returns it. The desktop renders it as a QR encoding
//      /pair?code=<code>.
//   2. The PHONE scans → opens /pair?code=… → POSTs /auth/pair/claim { code }.
//      Server atomically consumes the code and returns a normal session JWT for
//      the SAME user, plus the target workspace slug. The phone stores the
//      token, sets that workspace active, and lands in its scan inbox.
//   3. The desktop polls GET /auth/pair/status?code=… to auto-close its modal.
//
// Security posture (mirrors the magic-link / reset / verify flows):
//   - Single-use: claim sets claimed_at in one atomic UPDATE…WHERE…RETURNING;
//     a second claim returns 410.
//   - Short TTL (~5 min) — an unclaimed row is inert after expiry. (Was 90s;
//     finding + unlocking the phone routinely outran it, and unlike the
//     WhatsApp-style flows we don't auto-rotate the code.)
//   - High entropy: 128-bit randomBytes, URL-safe; stored sha256-HASHED, so the
//     plaintext only ever transits start-response → QR → claim.
//   - Rate-limited on BOTH start and claim (in-memory, per-IP) — defense in
//     depth on top of the already-infeasible brute force.
//   - Tenant-scoped: org_slug pins the workspace, and membership is verified at
//     start (the minter) AND claim (a membership revoked in between drops the
//     phone to its default workspace rather than a workspace it can't see).


const pairStartLimiter = makeIpLimiter(60_000, 20); // 20 mints / min / IP
const pairClaimLimiter = makeIpLimiter(60_000, 30); // 30 claims / min / IP
// Used by POST /identity/exchange (declared here with the other auth limiters; the handler
// above closes over it and only reads it at request time, so the forward reference is fine).
const identityExchangeLimiter = makeIpLimiter(60_000, 30); // 30 exchanges / min / IP

// Per-IP limiters for the unauthenticated credential surface. Caps brute-force (login),
// email floods (magic-request, password-forgot), and token probing. Generous enough that a
// real human (even behind NAT) never trips them.
const loginLimiter = makeIpLimiter(60_000, 30);
/** Password and email-link sign-in are off on this instance. */
const PASSWORD_SIGN_IN_OFF = {
  error: { code: "password_sign_in_off", message: "This server signs in through its own sign-in provider. Use the Sign in with button." },
} as const;
const signupLimiter = makeIpLimiter(60_000, 15);
const magicRequestLimiter = makeIpLimiter(60_000, 10);
const magicConsumeLimiter = makeIpLimiter(60_000, 30);
const passwordForgotLimiter = makeIpLimiter(60_000, 10);
const passwordResetLimiter = makeIpLimiter(60_000, 30);
const verifyEmailLimiter = makeIpLimiter(60_000, 30);

// GET /config is read by every sign-in page load before anyone types, and holds
// nothing to guess at: a generous bucket of its own (out of the request guard's
// shared one, see GUARD_EXEMPT_READS), so a busy shared network cannot lock
// everyone out of even SEEING the form (#3622).
const configLimiter = makeIpLimiter(60_000, 600);

const PairStartBody = z.object({ org_slug: z.string().min(1).max(120) });

// UI-SCREEN: /scan (Scan with your phone opens PairPhoneButton)
authRouter.post("/pair/start", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    if (!pairStartLimiter(req.ip ?? "unknown")) {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many pair codes — wait a moment." } });
      return;
    }
    const refusal = pairMintRefusal(req.session!);
    if (refusal) {
      res.status(403).json({ error: { code: "session_required", message: refusal } });
      return;
    }
    const parsed = PairStartBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "org_slug is required" } });
      return;
    }
    const orgSlug = parsed.data.org_slug;
    // The caller can only pair a phone into a workspace they're a member of.
    const membership = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("o.slug")
      .where("m.user_id", "=", userId)
      .where("o.slug", "=", orgSlug)
      .executeTakeFirst();
    if (!membership) {
      res.status(403).json({ error: { code: "not_a_member", message: "You're not a member of that workspace." } });
      return;
    }
    res.json(await mintPairCode(req, { userId, orgSlug, ttlMs: PAIR_CODE_TTL_MS }));
  } catch (err) {
    next(err);
  }
});

// POST (not GET) so the plaintext code travels in the body, never the query
// string — keeps a still-live code out of access logs.
authRouter.post("/pair/status", requireAuth, async (req, res, next) => {
  try {
    const code = typeof (req.body as { code?: unknown } | undefined)?.code === "string" ? (req.body as { code: string }).code : "";
    if (!code) {
      res.status(400).json({ error: { code: "no_code", message: "code is required" } });
      return;
    }
    const row = await meta
      .selectFrom("auth_pair_codes")
      .select(["user_id", "minted_by", "claimed_at", "expires_at", "revoked_at"])
      .where("code_hash", "=", hashPairCode(code))
      .executeTakeFirst();
    // Only the minter may poll — don't leak another user's code lifecycle. An
    // admin's code for a member (#6692) is the admin's to watch.
    if (!row || (row.minted_by ?? row.user_id) !== req.session!.id) {
      res.status(404).json({ error: { code: "not_found", message: "Pair code not found" } });
      return;
    }
    const state = row.claimed_at ? "claimed" : row.revoked_at || row.expires_at <= new Date() ? "expired" : "pending";
    res.json({ state });
  } catch (err) {
    next(err);
  }
});

const PairClaimBody = z.object({ code: z.string().min(1).max(200) });

// Unauthenticated — the phone has no session yet; the code IS the credential.
authRouter.post("/pair/claim", async (req, res, next) => {
  try {
    if (!pairClaimLimiter(req.ip ?? "unknown")) {
      rateLimited(res);
      return;
    }
    const parsed = PairClaimBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "code is required" } });
      return;
    }
    const now = new Date();
    // Atomic single-use consume: set claimed_at ONLY if still pending +
    // unexpired. RETURNING yields the row exactly when WE won the claim; an
    // empty result means already-claimed, expired, or never existed.
    const claimed = await meta
      .updateTable("auth_pair_codes")
      .set({ claimed_at: now })
      .where("code_hash", "=", hashPairCode(parsed.data.code))
      .where("claimed_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .returning(["user_id", "org_slug", "minted_by"])
      .executeTakeFirst();
    if (!claimed) {
      res.status(410).json({ error: { code: "pair_code_unusable", message: "Pair code expired or already claimed" } });
      return;
    }
    // The account must still be active.
    const user = await meta
      .selectFrom("users")
      .select(["id", "active", "must_reset_password"])
      .where("id", "=", claimed.user_id)
      .executeTakeFirst();
    if (!user || !user.active) {
      res.status(410).json({ error: { code: "pair_code_unusable", message: "Account unavailable" } });
      return;
    }
    // ...and the user must STILL be a member of the pinned workspace (it could
    // have been revoked between start and claim). If it's gone, sign them in
    // anyway and let the client fall back to their default workspace.
    const stillMember = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("o.slug")
      .where("m.user_id", "=", claimed.user_id)
      .where("o.slug", "=", claimed.org_slug)
      .executeTakeFirst();
    const targetOrgSlug = stillMember ? claimed.org_slug : null;
    // An admin's code signs someone in only into the workspace that admin
    // runs: with the membership gone it is nobody's to use, so it fails closed.
    if (claimed.minted_by && !stillMember) {
      res.status(410).json({ error: { code: "pair_code_unusable", message: "This sign-in code is for a workspace you are no longer in." } });
      return;
    }
    // An admin's code for an account they minted (#6692): the temp password
    // they were shown dies here, so nobody but the person holding this phone
    // can be them. The account has no password from now (the empty hash every
    // passwordless account has); another code, or a reset link to its
    // address, signs them in again.
    if (claimed.minted_by && user.must_reset_password) {
      await meta
        .updateTable("users")
        .set({ password_hash: "", must_reset_password: false })
        .where("id", "=", user.id)
        .execute();
    }
    const out = await buildAuthResponse(claimed.user_id);
    // Audit the login (best-effort — never block the claim on logging).
    // DETACHED: the audit row of a sign-in; the sign-in itself is complete without it
    void activity
      .log({
        orgId: (
          await meta
            .selectFrom("org_memberships")
            .select("org_id")
            .where("user_id", "=", claimed.user_id)
            .executeTakeFirstOrThrow()
        ).org_id,
        userId: claimed.user_id,
        action: "login",
        ref: { module: null, entityType: "user", entityId: claimed.user_id },
        diff: { method: "qr_pair", ...(claimed.minted_by ? { minted_by: claimed.minted_by } : {}) },
      })
      .catch((err) => console.error("[pair/claim] activity log failed:", err));
    res.json({ ...out, target_org_slug: targetOrgSlug });
  } catch (err) {
    next(err);
  }
});
