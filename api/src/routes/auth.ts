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

import { Router, type Request } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { meta, metaPool } from "../db/meta.js";
import { lockoutState, isLocked } from "../auth/lockout.js";
import { applyBlueprint, BlueprintManifest } from "./blueprint.js";
import { provisionTenantDb } from "../db/provision.js";
import { slugifyBase } from "../lib/slugify.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { TRIAL_MODE, TRIAL_TTL_DAYS } from "../platform/trial.js";
import { verifyCaptcha, captchaEnabled } from "../platform/captcha.js";
import { blockDisposableEnabled, isDisposableEmail } from "../platform/disposable-emails.js";

// A throwaway hash, computed once, so the "no such user / inactive" login
// path spends the same ~bcrypt time as a real password check — otherwise the
// timing difference leaks which emails are registered. (Audit 2026-06-26 P2.)
let _dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!_dummyHash) _dummyHash = hashPassword("cobblr-login-timing-equalizer");
  return _dummyHash;
}
import { signSession } from "../auth/jwt.js";
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
} from "../auth/identity-client.js";
import { isPlatformAdmin, requireAuth } from "../auth/middleware.js";
import { publicSignupEnabled, managedAppSignupEnabled, selfServeInvitesEnabled } from "../auth/signup-gate.js";
import { dispatch } from "../platform/notifications.js";
import { isUndeliverableTestAddress } from "../platform/email-send.js";
import * as activity from "../platform/activity.js";
import { fireSignup, sendAuthEmail } from "../platform/hosted-seams.js";
import { discordInviteUrl, discordAppId } from "../platform/discord-oauth.js";
import { communityLinks, type CommunityLink } from "../platform/community.js";
import { enableDefaultModulesForOrg } from "../modules/enable.js";
import { provisionAppWorkspace, ProvisionAppError } from "../platform/provision-app.js";
import type { OrgRole } from "../db/schema.js";

class SkipNotify extends Error {}

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
  captcha_token: z.string().max(4096).optional(),
  // Optional when `app` is set — a managed-app signup names the workspace
  // after the app (the consumer never picks a workspace name).
  org_name: z.string().min(1).max(120).optional(),
  /** Single-use signup-invite token. When public signup is disabled, a
   *  valid token authorises this registration (the invite-only gate). */
  invite_token: z.string().max(200).optional(),
  /** Managed-app signup ("Cobblr for Yarn"): provision the user's first (only)
   *  workspace AS this app — install its flagship bundle + lock it into app
   *  mode — instead of a generic workspace. `manifest` is the app's bundle
   *  (caller-supplied for now; server-side registry fetch is the follow-up). */
  app: z.string().min(1).optional(),
  manifest: z.unknown().optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

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
   *  password. Web client redirects to /me/force-password-reset
   *  until the user clears the flag via PATCH /me/password. */
  must_reset_password: boolean;
  /** True once the user confirmed their email via a verification link.
   *  Informational (login is not gated on it); the web shows a "verify your
   *  email" banner while false. Existing users were grandfathered to true. */
  email_verified: boolean;
  /** True when the user's email is in SUPERADMIN_EMAILS. Must be set
   *  on the login/signup response too (not just /me) — else the
   *  super-admin UI shows "access denied" until the next /me refresh. */
  is_platform_admin: boolean;
  /** Community Discord invite (DISCORD_INVITE_URL) or null; signed-in chrome only. */
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

  let provisioned = false;
  try {
    const { credentialsEncrypted, migrationsApplied } = await provisionTenantDb(dbName);
    await meta
      .updateTable("orgs")
      .set({ db_credentials_encrypted: credentialsEncrypted, updated_at: new Date() })
      .where("id", "=", orgId)
      .execute();
    console.log(`[org-provision] ${dbName} for org ${orgId} (${migrationsApplied} migrations)`);
    provisioned = true;
  } catch (err) {
    console.error(`[org-provision] FAILED to provision ${dbName}:`, err);
  }

  try {
    await activity.log({
      orgId,
      userId,
      action: "org_created",
      ref: { module: null, entityType: "org", entityId: orgId },
      diff: { name: orgName, db_name: dbName },
    });
    if (provisioned) {
      await activity.log({
        orgId,
        userId,
        action: "tenant_provisioned",
        ref: { module: null, entityType: "org", entityId: orgId },
        diff: { db_name: dbName },
      });
    }
  } catch (err) {
    console.error("[org-provision] activity logging failed:", err);
  }

  if (provisioned) {
    try {
      // New workspace gets the always-on substrate (foundational) plus
      // the ambient capability modules (autoEnable) — views, search,
      // scan, ai, apps, … — which carry no decision content and do
      // nothing until used. Only DOMAIN modules (inventory, machines,
      // digifab, …) stay off until the user opts in: choosing what you
      // *manage* is the one decision worth surfacing.
      const enabled = await enableDefaultModulesForOrg(orgId, userId);
      if (enabled.length > 0) {
        console.log(`[org-provision] enabled default modules for ${orgId}: ${enabled.join(", ")}`);
      }
    } catch (err) {
      console.error("[org-provision] default-module enable failed:", err);
    }
    // Default wires for the org get installed transitively when
    // `enableDefaultModulesForOrg` enables each module — `enableModuleForOrg`
    // iterates `manifest.contributes.wires` and inserts every entry.
    // The backfillDefaultBindings call at boot covers orgs created
    // before a given default wire was added to the manifest.
  }

  return { orgId, slug, dbName, provisioned };
}

export async function buildAuthResponse(userId: string): Promise<AuthResponse> {
  const user = await meta
    .selectFrom("users")
    .select(["id", "email", "display_name", "must_reset_password", "email_verified_at"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  const orgs = await listMembershipsForUser(userId);

  const token = await signSession(userId);
  const { email_verified_at, ...rest } = user;
  return {
    token,
    user: {
      ...rest,
      email_verified: email_verified_at !== null,
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

authRouter.get("/config", (_req, res) => {
  res.json({
    signup_enabled: publicSignupEnabled(),
    self_serve_invites: selfServeInvitesEnabled(),
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
    // Central identity, for the "sign in with your Cobblr account" button. Null unless
    // BOTH halves are configured, because a button that starts a hand-off this surface
    // cannot finish is worse than no button: it fails after the redirect, on somebody
    // else's site, where nothing here can explain it.
    //
    // `authorize_url` is where the browser goes; the surface names itself so the
    // account service knows which secret to expect back.
    identity: identityCallbackEnabled()
      ? {
          authorize_url: `${browserBase()}/authorize`,
          deployment: deploymentId(),
          // Whose account it is. Configurable because nothing else in this feature is
          // Cobblr-specific: point IDENTITY_URL at your own service and the button
          // should say your name, not ours.
          name: (process.env.IDENTITY_NAME ?? "").trim() || "Cobblr",
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
    if (overLimit(signupLimiter, req)) return res.status(429).json(RATE_LIMITED);
    const body = SignupBody.parse(req.body);
    const email = body.email.toLowerCase().trim();

    // ── abuse guards ── both no-op unless configured (the trial box turns them
    // on); run before any DB work so a bot never touches the invite/user path.
    if (!(await verifyCaptcha(body.captcha_token, req.ip))) {
      return res.status(400).json({
        error: { code: "captcha_failed", message: "Captcha verification failed. Please try again." },
      });
    }
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
    if (!publicSignupEnabled() && !isManagedAppSignup && !body.invite_token) {
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
    // so signup and POST /orgs share the same code path).
    const userRow = await meta
      .insertInto("users")
      .values({
        email,
        password_hash,
        display_name: body.display_name.trim(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const userId = userRow.id;

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
          });
        }
      } catch (err) {
        if (!(err instanceof SkipNotify)) console.error("[signup] invite-accepted notification failed:", err);
      }
    }

    // Phase 2: provision the user's first org. A managed-app signup ("Cobblr
    // for Yarn") makes that workspace the app itself (bundle + app mode);
    // otherwise it's a generic workspace.
    const provisioned = body.app
      ? await provisionAppWorkspace(userId, body.app, body.manifest, { auth_method: "session" })
      : await provisionOrgForUser(userId, body.org_name ?? `${body.display_name.trim()}'s workspace`);

    // Lifecycle seam: the hosted overlay attaches here. No-op in open core.
    await fireSignup({ userId, email, orgId: provisioned.orgId });

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
        error: { code: "invalid_body", message: "Bad signup payload", details: err.issues },
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

/** Read the shared per-account lockout row for a (lowercased) email. */
async function readLoginAttempt(email: string): Promise<{ failed_count: number; locked_until: Date | null } | undefined> {
  return meta
    .selectFrom("login_attempts")
    .select(["failed_count", "locked_until"])
    .where("email", "=", email)
    .executeTakeFirst();
}

/** Record one failed login for `email`: atomically bump the consecutive-failure
 *  count in cobblr_meta (shared across api instances) and set locked_until per
 *  the backoff once the threshold is crossed. Bucketed by submitted email so it
 *  behaves the same for registered and unregistered addresses. */
async function recordFailedLogin(email: string, now: Date): Promise<void> {
  const row = await meta
    .insertInto("login_attempts")
    .values({ email, failed_count: 1, last_failed_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.column("email").doUpdateSet({
        failed_count: sql`login_attempts.failed_count + 1`,
        last_failed_at: now,
        updated_at: now,
      }),
    )
    .returning("failed_count")
    .executeTakeFirstOrThrow();
  const decision = lockoutState(row.failed_count, now);
  if (decision.locked) {
    await meta
      .updateTable("login_attempts")
      .set({ locked_until: decision.lockedUntil, updated_at: now })
      .where("email", "=", email)
      .execute();
  }
}

/** Clear the counter after a proven-correct password so a legitimate user's
 *  earlier typos never accumulate toward a lock. */
async function clearLoginAttempts(email: string): Promise<void> {
  await meta.deleteFrom("login_attempts").where("email", "=", email).execute();
}

authRouter.post("/login", async (req, res, next) => {
  try {
    if (overLimit(loginLimiter, req)) return res.status(429).json(RATE_LIMITED);
    const body = LoginBody.parse(req.body);
    const email = body.email.toLowerCase().trim();
    const now = new Date();

    // Same response for "no user" + "wrong password" so we don't
    // leak which emails are registered.
    const denied = () =>
      res.status(401).json({
        error: { code: "invalid_credentials", message: "Email or password incorrect." },
      });

    // Per-account lockout (shared across api instances via cobblr_meta), checked
    // BEFORE the password so a locked account never reaches the hash. Bucketed by
    // submitted email, so a locked response is identical for existing and
    // non-existing accounts — no enumeration oracle. Skipped under the test rig,
    // which logs in thousands of times as the same handful of accounts.
    if (!AUTH_LIMITS_OFF) {
      const attempt = await readLoginAttempt(email);
      if (attempt && isLocked(attempt.locked_until, now)) {
        // Spend ~bcrypt time so the locked path's latency matches the others.
        await verifyPassword(body.password, await dummyPasswordHash());
        return res.status(429).json(ACCOUNT_LOCKED);
      }
    }

    const user = await meta
      .selectFrom("users")
      .select(["id", "email", "password_hash", "active", "email_verified_at"])
      .where("email", "=", email)
      .executeTakeFirst();

    if (!user || !user.active) {
      // Spend the same ~bcrypt time as the real path so a missing/inactive
      // account isn't distinguishable by latency. (Audit 2026-06-26 P2.)
      await verifyPassword(body.password, await dummyPasswordHash());
      if (!AUTH_LIMITS_OFF) await recordFailedLogin(email, now);
      return denied();
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      if (!AUTH_LIMITS_OFF) await recordFailedLogin(email, now);
      return denied();
    }
    // Correct password — the credential is proven, so clear any prior failures
    // (the account is not brute-forced) before the email-verification gate.
    if (!AUTH_LIMITS_OFF) await clearLoginAttempts(email);

    // Email-verification gate (trial): deny login until verified, and resend the
    // link so the user has a fresh one. No-op unless COBBLR_REQUIRE_EMAIL_VERIFY.
    if (requireEmailVerify() && !user.email_verified_at) {
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
        error: { code: "invalid_body", message: "Bad login payload", details: err.issues },
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
const IdentityCallbackBody = z.object({ code: z.string().min(20).max(512) });

type AdoptResult = { userId: string } | { status: number; error: { code: string; message: string } };

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
async function adoptOrProvisionIdentity(identityId: string, identityToken: string): Promise<AdoptResult> {
  const profile = await fetchIdentityProfile(identityToken);
  if (!profile) return NO_LOCAL_ACCOUNT;
  if (!profile.emailVerified) {
    return {
      status: 403,
      error: { code: "email_unverified", message: "Confirm your email address on your Cobblr account first." },
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
    return { userId: byEmail.id };
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
  const created = await meta
    .insertInto("users")
    .values({
      email: profile.email,
      password_hash,
      display_name: profile.displayName,
      identity_id: identityId,
      email_verified_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const provisioned = await provisionOrgForUser(created.id, `${profile.displayName}'s workspace`);
  // Same lifecycle seam signup uses, so the hosted overlay sees these accounts too
  // (trial stamping, welcome flows) rather than only the ones that came through a form.
  await fireSignup({ userId: created.id, email: profile.email, orgId: provisioned.orgId });
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
  console.log(`[identity] provisioned a workspace for a central account (${created.id})`);
  return { userId: created.id };
}

authRouter.post("/identity/callback", async (req, res, next) => {
  try {
    if (!identityCallbackEnabled()) {
      return res.status(404).json({
        error: { code: "identity_disabled", message: "Central identity is not enabled on this surface." },
      });
    }
    if (!identityExchangeLimiter(req.ip ?? "unknown")) {
      return res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts — wait a moment." } });
    }
    const { code } = IdentityCallbackBody.parse(req.body);
    const redeemed = await redeemIdentityCode(code);
    if (!redeemed) {
      return res.status(401).json({
        error: { code: "invalid_code", message: "That sign-in link has expired or was already used." },
      });
    }
    let identityId: string;
    try {
      identityId = await verifyIdentityToken(redeemed);
    } catch {
      // The account service handed us something we cannot verify. That is a
      // configuration fault (issuer, audience, or a rotated key), not a bad user.
      return res.status(502).json({
        error: { code: "identity_token_invalid", message: "The account service returned a token this surface cannot verify." },
      });
    }
    const linked = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("identity_id", "=", identityId)
      .executeTakeFirst();
    // A disabled account is a decision somebody made, so it stops here rather than
    // falling through to the path that would hand it a fresh workspace.
    if (linked && !linked.active) {
      return res.status(403).json({
        error: { code: "account_disabled", message: "This account is disabled on this surface." },
      });
    }
    let userId = linked?.id;
    if (!userId) {
      const outcome = await adoptOrProvisionIdentity(identityId, redeemed);
      if ("error" in outcome) return res.status(outcome.status).json({ error: outcome.error });
      userId = outcome.userId;
    }
    await meta.updateTable("users").set({ last_login_at: new Date() }).where("id", "=", userId).execute();
    return res.json(await buildAuthResponse(userId));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { code: "invalid_body", message: "Bad callback payload", details: err.issues } });
    }
    return next(err);
  }
});

authRouter.post("/identity/exchange", async (req, res, next) => {
  try {
    if (!identityEnabled()) {
      return res.status(404).json({ error: { code: "identity_disabled", message: "Central identity is not enabled on this surface." } });
    }
    // Unauthenticated + does a jwtVerify and a users lookup — cap bursts (token probing /
    // identity enumeration / CPU) like every other auth endpoint here.
    if (!identityExchangeLimiter(req.ip ?? "unknown")) {
      return res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts — wait a moment." } });
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
      return res.status(400).json({ error: { code: "invalid_body", message: "Bad exchange payload", details: err.issues } });
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

const MAGIC_TTL_MS = 15 * 60 * 1000;

function hashMagicToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}
function mintMagicToken(): { plain: string; hash: string } {
  // 32 bytes → 43-char URL-safe base64.
  const plain = randomBytes(32).toString("base64url");
  return { plain, hash: hashMagicToken(plain) };
}

const MagicRequest = z.object({
  email: z.string().email().max(255),
});

authRouter.post("/magic/request", async (req, res, next) => {
  try {
    if (overLimit(magicRequestLimiter, req)) return res.status(429).json(RATE_LIMITED);
    const parsed = MagicRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues },
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
    if (!existingForLink && !isPlatformAdmin(email) && !publicSignupEnabled()) {
      res.status(202).json({
        ok: true,
        expires_at: new Date(Date.now() + MAGIC_TTL_MS).toISOString(),
        message: "If that email exists or is allowed to sign in, a magic link has been issued.",
      });
      return;
    }

    const { plain, hash } = mintMagicToken();
    await meta
      .insertInto("auth_magic_tokens")
      .values({
        email,
        token_hash: hash,
        request_ip: (req.ip ?? null) as string | null,
        request_ua: (req.get("user-agent") ?? null) as string | null,
      })
      .execute();

    // Dev mode: return the plaintext + a copy-paste-able URL so the
    // demo flow works without SMTP. A production env that wires
    // email delivery (via an auth.magic.requested event subscriber
    // in a future module) should set NODE_ENV=production AND the
    // requester won't see the link in the response.
    const link = `/auth/magic?token=${encodeURIComponent(plain)}`;
    const absLink = `${req.protocol}://${req.get("host") ?? ""}${link}`;
    // Deliver via the registered auth-email sender (a self-hoster's SMTP/API or
    // the managed overlay) when one exists. No sender → fall back to the inline
    // dev link below. This is the seam that turns magic-link from a dev-only
    // affordance into a real prod flow.
    const emailed = await sendAuthEmail({
      to: email,
      subject: "Your Cobblr sign-in link",
      text: `Sign in to Cobblr:\n\n${absLink}\n\nThe link expires shortly. If you didn't request it, you can ignore this email.`,
      kind: "magic_link",
    });
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
    if (overLimit(magicConsumeLimiter, req)) return res.status(429).json(RATE_LIMITED);
    const parsed = MagicConsume.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues },
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
    // somewhere to land.
    const existing = await meta
      .selectFrom("users")
      .select(["id", "active"])
      .where("email", "=", row.email)
      .executeTakeFirst();

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
      if (!publicSignupEnabled() && !isPlatformAdmin(row.email)) {
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
      const defaultName = row.email.split("@")[0] ?? "user";
      const inserted = await meta
        .insertInto("users")
        .values({
          email: row.email,
          password_hash: "", // empty; verifyPassword will reject all
          display_name: defaultName,
          // Clicking the magic link proves control of the email → verified.
          email_verified_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      userId = inserted.id;
      // Give them a starter workspace named after them.
      try {
        await provisionOrgForUser(userId, `${defaultName}'s workspace`);
      } catch (err) {
        console.error("[magic/consume] org provision failed:", err);
      }
    }

    await meta
      .updateTable("users")
      .set({ last_login_at: new Date() })
      .where("id", "=", userId)
      .execute();
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
    return res.json(out);
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
    if (overLimit(passwordForgotLimiter, req)) {
      res.status(429).json(RATE_LIMITED);
      return;
    }
    const parsed = PasswordForgot.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues } });
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
      const absLink = `${req.protocol}://${req.get("host") ?? ""}/reset/${plain}`;
      const emailed = await sendAuthEmail({
        to: email,
        subject: "Reset your Cobblr password",
        text:
          `Someone asked to reset your Cobblr password. Open this link to choose a new one:\n\n${absLink}\n\n` +
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
    if (overLimit(passwordResetLimiter, req)) return res.status(429).json(RATE_LIMITED);
    const parsed = PasswordReset.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues } });
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
    await meta.updateTable("auth_password_reset_tokens").set({ consumed_at: new Date() }).where("id", "=", row.id).execute();
    await meta
      .updateTable("users")
      // tokens_valid_from = now() revokes every existing session/app JWT — a
      // password reset is exactly when a stolen token must die. Audit #6.
      .set({ password_hash: newHash, must_reset_password: false, tokens_valid_from: new Date() })
      .where("id", "=", row.user_id)
      .execute();

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
  const absLink = `${req.protocol}://${req.get("host") ?? ""}/verify/${plain}`;
  const emailed = await sendAuthEmail({
    to: normalized,
    subject: "Verify your Cobblr email",
    text:
      `Confirm your email to finish setting up your Cobblr account:\n\n${absLink}\n\n` +
      `This link expires in 24 hours. If you didn't create a Cobblr account, you can ignore this email.`,
    kind: "verify_email",
  });
  return { emailed, devToken: !emailed && process.env.NODE_ENV !== "production" ? plain : undefined };
}

// ───────────────── POST /auth/verify-email ─────────────────
// Public: consumes a verification token + marks the user's email verified.
const VerifyEmail = z.object({ token: z.string().min(8).max(200) });

authRouter.post("/verify-email", async (req, res, next) => {
  try {
    if (overLimit(verifyEmailLimiter, req)) {
      res.status(429).json(RATE_LIMITED);
      return;
    }
    const parsed = VerifyEmail.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues } });
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

const PAIR_CODE_TTL_MS = 300 * 1000;

function hashPairCode(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

// Minimal in-memory sliding-window limiter — this api carries no
// express-rate-limit dependency. Per-instance + best-effort: brute-forcing a
// 128-bit, short-lived, single-use code is already infeasible; this just caps
// accidental floods + abusive bursts. Keyed by client IP.
function makePairLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    // Opportunistic cleanup so the map can't grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= windowMs)) hits.delete(k);
      }
    }
    return true;
  };
}
const pairStartLimiter = makePairLimiter(60_000, 20); // 20 mints / min / IP
const pairClaimLimiter = makePairLimiter(60_000, 30); // 30 claims / min / IP
// Used by POST /identity/exchange (declared here with the other auth limiters; the handler
// above closes over it and only reads it at request time, so the forward reference is fine).
const identityExchangeLimiter = makePairLimiter(60_000, 30); // 30 exchanges / min / IP

// Per-IP limiters for the unauthenticated credential surface. Caps brute-force (login),
// email floods (magic-request, password-forgot), and token probing. Generous enough that a
// real human (even behind NAT) never trips them.
const loginLimiter = makePairLimiter(60_000, 30);
const signupLimiter = makePairLimiter(60_000, 15);
const magicRequestLimiter = makePairLimiter(60_000, 10);
const magicConsumeLimiter = makePairLimiter(60_000, 30);
const passwordForgotLimiter = makePairLimiter(60_000, 10);
const passwordResetLimiter = makePairLimiter(60_000, 30);
const verifyEmailLimiter = makePairLimiter(60_000, 30);

// The CI test harness logs in thousands of times from ONE ip (localhost) — the limits
// protect PROD, not the harness, so bypass them under the test rig. COBBLR_TEST_ORG_POOL is
// set only in ci.yml / the test rig (env.ts), never in prod.
const AUTH_LIMITS_OFF = process.env.NODE_ENV === "test" || !!process.env.COBBLR_TEST_ORG_POOL;
/** True when this request should be rejected as over-limit. No-op under the test rig. */
function overLimit(limiter: (k: string) => boolean, req: Request): boolean {
  return !AUTH_LIMITS_OFF && !limiter(req.ip ?? "unknown");
}
const RATE_LIMITED = { error: { code: "rate_limited", message: "Too many attempts — wait a moment." } };

const PairStartBody = z.object({ org_slug: z.string().min(1).max(120) });

authRouter.post("/pair/start", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    if (!pairStartLimiter(req.ip ?? "unknown")) {
      res.status(429).json({ error: { code: "rate_limited", message: "Too many pair codes — wait a moment." } });
      return;
    }
    // Reaper (best-effort, fire-and-forget): keep the table bounded by dropping
    // rows well past expiry. Cheap, runs only on a mint, never blocks the claim.
    void meta
      .deleteFrom("auth_pair_codes")
      .where("expires_at", "<", new Date(Date.now() - 3_600_000))
      .execute()
      .catch((err) => console.error("[pair/start] reaper failed:", err));
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
    // 128-bit URL-safe code: ample entropy for a short-lived single-use code, compact
    // enough to keep the QR low-density. Stored hashed — plaintext only goes
    // out in this response (→ QR → phone).
    const code = randomBytes(16).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
    await meta
      .insertInto("auth_pair_codes")
      .values({
        user_id: userId,
        org_slug: orgSlug,
        code_hash: hashPairCode(code),
        expires_at: expiresAt,
        request_ip: (req.ip ?? null) as string | null,
        request_ua: (req.get("user-agent") ?? null) as string | null,
      })
      .execute();
    // The phone visits /pair?code=… . Offer a claim URL for every base this
    // server is reachable at — the request origin (on Cobblr's Cloudflare-
    // tunnel'd prod that IS the phone-reachable public URL, e.g.
    // https://cobblr.example.com) plus an optional PUBLIC_BASE_URL for self-hosters who
    // expose a separate LAN/Tailscale address. localhost bases are dropped when
    // a real one exists (a phone can't resolve the desktop's localhost).
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.get("host");
    const reqBase = host ? `${proto}://${host}`.replace(/\/+$/, "") : null;
    const pubBase = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null;
    const bases: string[] = [];
    for (const b of [reqBase, pubBase]) {
      if (b && !bases.some((x) => x.toLowerCase() === b.toLowerCase())) bases.push(b);
    }
    const isLocal = (b: string) => /\/\/(localhost|127\.0\.0\.1)/i.test(b);
    const usable = bases.some((b) => !isLocal(b)) ? bases.filter((b) => !isLocal(b)) : bases;
    const claimOptions = usable.map((b) => {
      let label = b;
      try {
        label = new URL(b).host;
      } catch {
        /* non-URL base — keep verbatim */
      }
      return { label, url: `${b}/pair?code=${code}` };
    });
    if (claimOptions.length === 0) claimOptions.push({ label: "default", url: `/pair?code=${code}` });
    res.json({
      code,
      expires_at: expiresAt.toISOString(),
      claim_url: claimOptions[0]!.url,
      claim_options: claimOptions,
    });
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
      .select(["user_id", "claimed_at", "expires_at"])
      .where("code_hash", "=", hashPairCode(code))
      .executeTakeFirst();
    // Only the minter may poll — don't leak another user's code lifecycle.
    if (!row || row.user_id !== req.session!.id) {
      res.status(404).json({ error: { code: "not_found", message: "Pair code not found" } });
      return;
    }
    const state = row.claimed_at ? "claimed" : row.expires_at <= new Date() ? "expired" : "pending";
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
      res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts — wait a moment." } });
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
      .where("expires_at", ">", now)
      .returning(["user_id", "org_slug"])
      .executeTakeFirst();
    if (!claimed) {
      res.status(410).json({ error: { code: "pair_code_unusable", message: "Pair code expired or already claimed" } });
      return;
    }
    // The account must still be active.
    const user = await meta
      .selectFrom("users")
      .select(["id", "active"])
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
    const out = await buildAuthResponse(claimed.user_id);
    // Audit the login (best-effort — never block the claim on logging).
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
        diff: { method: "qr_pair" },
      })
      .catch((err) => console.error("[pair/claim] activity log failed:", err));
    res.json({ ...out, target_org_slug: targetOrgSlug });
  } catch (err) {
    next(err);
  }
});
