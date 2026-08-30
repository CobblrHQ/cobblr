// The no-account sandbox: an hour of Cobblr from one link.
// Spec: docs/design-decisions/try-sandbox.md
//
// A visitor presses "Try it" and is inside a real workspace without typing
// anything. The link they land on IS the credential, and it is the only way
// back in, so it stays valid for the sandbox's whole life rather than being
// consumed like a magic link.
//
// OFF unless COBBLR_TRY_SANDBOX=true. Prod, staging and every self-host leave
// it unset, so none of this is reachable there — the routes are not even
// registered (see routes/try.ts). It is deliberately a separate flag from
// COBBLR_TIER=trial: the trial box could reasonably want account signups
// without also handing out anonymous workspaces.
//
// Why a path token and not a subdomain per sandbox: Cobblr identifies a
// workspace by PATH (`/w/<slug>`), nothing in the api resolves a tenant from
// the Host header, and the session is a localStorage JWT. A subdomain would
// need wildcard DNS, wildcard tunnel ingress, host→tenant resolution that does
// not exist, and per-host CORS — to buy cookie isolation that auth does not
// use.
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { expiredSandboxesQuery } from "./try-sandbox-query.js";
import { hashToken } from "./try-sandbox-token.js";
import { mintSandboxToken } from "./try-sandbox-token.js";
import { hashPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";

/** True only on a box that opted in. */
export function sandboxEnabled(): boolean {
  return env.COBBLR_TRY_SANDBOX === true;
}

export function sandboxTtlMs(): number {
  return env.TRY_SANDBOX_TTL_MINUTES * 60_000;
}

// The token helpers live in their own module so they can be tested without a
// database or the env schema; re-exported here so callers have one import.
export { mintSandboxToken, hashToken } from "./try-sandbox-token.js";

// ── the caps ──────────────────────────────────────────────────────────────
// Rate limits (per-IP, global) live in the request guard with the other
// path-class limits. THIS is the different one: a ceiling on how many
// sandboxes exist at once, which is what actually protects the box. Every
// sandbox is a real Postgres database (db-per-tenant), and the try-instance
// capacity note puts the ceiling at a few hundred live tenants before
// PgBouncer. A rate limit bounds arrivals; only this bounds the population.

export interface CapacityVerdict {
  ok: boolean;
  live: number;
  max: number;
}

/** How many sandboxes are currently unexpired, and whether there is room. */
export async function sandboxCapacity(now: number = Date.now()): Promise<CapacityVerdict> {
  const max = env.TRY_SANDBOX_MAX_LIVE;
  const row = await meta
    .selectFrom("orgs")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where("sandbox", "=", true)
    .where("trial_expires_at", ">", new Date(now))
    .executeTakeFirst();
  const live = Number(row?.n ?? 0);
  return { ok: live < max, live, max };
}

// ── provisioning ──────────────────────────────────────────────────────────

export interface SandboxResult {
  orgId: string;
  slug: string;
  userId: string;
  /** The plain token — returned once, never stored, never logged. */
  token: string;
  expiresAt: Date;
}

export interface ProvisionDeps {
  /** Injected so the route's own provisioning path can be tested without
   *  standing up a tenant database. */
  provisionOrg: (userId: string, orgName: string) => Promise<{ orgId: string; slug: string }>;
  enableDefaults: (orgId: string, userId: string) => Promise<unknown>;
  now?: () => number;
}

/** The synthetic account behind a sandbox.
 *
 *  It needs a real `users` row because every session, every activity-log entry
 *  and every ownership check in the platform is keyed on a user. The email is
 *  in the reserved `.invalid` TLD (RFC 2606) so it can never collide with, or
 *  be mistaken for, somebody's real address, and it is unique per sandbox so
 *  two visitors are never the same account.
 *
 *  The password column is NOT NULL and this account has no password, so it
 *  gets a hash of 32 random bytes — nothing anyone can type will ever match
 *  it. Same reasoning, and same code, as the central-identity path in
 *  routes/auth.ts: a sentinel string would have to be excluded at every
 *  comparison site forever. */
/** The domain every sandbox user's address ends with. Not a real one (RFC 2606
 *  reserves .invalid), which is the point: nothing can ever be delivered there,
 *  and it doubles as the durable marker that an account was never a person -
 *  still true after the workspace it belonged to has been deleted. */
export const SANDBOX_EMAIL_DOMAIN = "try.invalid";

/** Is this account a sandbox guest rather than somebody who signed up?
 *
 *  Asked at the doors a guest must not walk through. "Keep this workspace"
 *  rebinds the address to a real one, so somebody who converted stops matching
 *  and gets the ordinary account they asked for. */
export async function isSandboxUser(userId: string): Promise<boolean> {
  const row = await meta.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
  return !!row?.email?.endsWith(`@${SANDBOX_EMAIL_DOMAIN}`);
}

/** Delete guest accounts that no longer belong to any workspace.
 *
 *  A sandbox user exists only for its sandbox, and hardDeleteOrg removes the
 *  org without touching the account - so the guest survived their workspace,
 *  holding a session that still authenticated. requireAuth loads the user on
 *  every request, so removing it is what actually ends the session.
 *
 *  Scoped to guests with no remaining membership, so it can never reach
 *  somebody who kept their workspace (their address is real by then) or a
 *  sandbox still waiting in the pool (its org still exists). */
export async function pruneOrphanSandboxUsers(): Promise<number> {
  const res = await meta
    .deleteFrom("users")
    .where("email", "like", `%@${SANDBOX_EMAIL_DOMAIN}`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("org_memberships")
            .select("org_memberships.user_id")
            .whereRef("org_memberships.user_id", "=", "users.id"),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

async function createSandboxUser(handle: string): Promise<string> {
  const password_hash = await hashPassword(randomBytes(32).toString("base64"));
  const row = await meta
    .insertInto("users")
    .values({
      email: `sandbox-${handle}@${SANDBOX_EMAIL_DOMAIN}`,
      password_hash,
      display_name: "Guest",
      // Nothing will ever be sent here, and an unverified flag would make the
      // app nag a visitor about an address that is not theirs.
      email_verified_at: new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Build the workspace, and STOP before the clock starts.
 *
 *  Split from handing one over so a sandbox can be made in advance. An
 *  unclaimed one carries `trial_expires_at IS NULL`, which the reaper's
 *  `trial_expires_at < now` can never match (SQL null comparison), so a waiting
 *  sandbox is invisible to it without a column or a flag to keep in step. Its
 *  hour begins when somebody actually arrives. */
export interface SandboxWorkspace {
  orgId: string;
  slug: string;
  userId: string;
}

export async function provisionSandboxWorkspace(deps: ProvisionDeps): Promise<SandboxWorkspace> {
  const handle = randomBytes(6).toString("hex");
  const userId = await createSandboxUser(handle);
  // Provisioned under a UNIQUE name so the slug is unguessable, then renamed to
  // the thing a person should see.
  //
  // Naming every one "Sandbox" produced sandbox, sandbox-2, sandbox-4 - which
  // put a guessable, sequential id in the address bar and told anybody looking
  // how many sandboxes had ever been made. The display name is what the
  // switcher and the browser tab show, so it is set back afterwards and nobody
  // sees the handle.
  const { orgId, slug } = await deps.provisionOrg(userId, `Sandbox ${handle}`);
  // trial_expires_at back to NULL, explicitly.
  //
  // provisionOrgForUser stamps the tier's TTL - thirty DAYS on trial - and NULL
  // is what marks a sandbox as not yet handed over. Leaving the stamp in place
  // meant a pooled sandbox never looked ready, so the pool believed it was empty
  // and built another every twenty seconds: eight databases in three minutes,
  // none of them claimable, each one sitting for a month. Nothing errored.
  await meta
    .updateTable("orgs")
    .set({ name: "Sandbox", sandbox: true, trial_expires_at: null })
    .where("id", "=", orgId)
    .execute();

  // Same enable path signup uses, so a sandbox is an ordinary workspace: the
  // module denylist still applies (it is enforced in enableModuleForOrg), so
  // this cannot hand out what the tier withholds.
  await deps.enableDefaults(orgId, userId);
  return { orgId, slug, userId };
}

/** Start the clock and mint the link. The moment a sandbox becomes somebody's. */
export async function handOverSandbox(
  ws: SandboxWorkspace,
  now: number = Date.now(),
): Promise<SandboxResult> {
  const expiresAt = new Date(now + sandboxTtlMs());
  await meta
    .updateTable("orgs")
    .set({ trial_expires_at: expiresAt })
    .where("id", "=", ws.orgId)
    .execute();
  const { plain, hash } = mintSandboxToken();
  await meta
    .insertInto("try_sandbox_tokens")
    .values({ org_id: ws.orgId, user_id: ws.userId, token_hash: hash, expires_at: expiresAt })
    .execute();
  return { ...ws, token: plain, expiresAt };
}

/** Provision one sandbox and hand it straight over. The path taken when no
 *  ready-made one is waiting. */
export async function provisionSandbox(deps: ProvisionDeps): Promise<SandboxResult> {
  const ws = await provisionSandboxWorkspace(deps);
  return handOverSandbox(ws, deps.now?.() ?? Date.now());
}

// ── redeeming ─────────────────────────────────────────────────────────────

export type RedeemResult =
  | { ok: true; sessionToken: string; slug: string; expiresAt: Date }
  | { ok: false; reason: "unknown" | "expired" | "revoked" };

/** Exchange the link for a session. Deliberately NOT single-use: with no
 *  account, this link is the only way back to the workspace, so a refresh or a
 *  second device has to keep working for the sandbox's lifetime. */
export async function redeemSandboxToken(plain: string): Promise<RedeemResult> {
  const row = await meta
    .selectFrom("try_sandbox_tokens")
    .innerJoin("orgs", "orgs.id", "try_sandbox_tokens.org_id")
    .select([
      "try_sandbox_tokens.user_id as user_id",
      "try_sandbox_tokens.expires_at as expires_at",
      "try_sandbox_tokens.revoked_at as revoked_at",
      "orgs.slug as slug",
    ])
    .where("try_sandbox_tokens.token_hash", "=", hashToken(plain))
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    sessionToken: await signSession(row.user_id),
    slug: row.slug,
    expiresAt: new Date(row.expires_at),
  };
}

// ── keeping it ────────────────────────────────────────────────────────────

/** Bind an email to a sandbox and promote it to an ordinary account trial.
 *
 *  This is the ONLY door out of the sandbox, and it is deliberately at the
 *  exit rather than the entrance: asking for an address before someone has
 *  seen anything is the friction the sandbox exists to remove, while asking at
 *  the moment they want to keep what they built is intent — and one address
 *  per kept workspace is real abuse friction applied only to people who have
 *  already shown they are not a script.
 *
 *  After this the workspace is indistinguishable from one that signed up
 *  normally: the 30-day trial TTL, the humane warn → grace → delete reaper,
 *  and the magic link as the way back in. */
/** How long a kept workspace's original link keeps working after the upgrade.
 *  Long enough to survive a slow email, a spam folder, or coming back tomorrow;
 *  short enough that a URL somebody pasted into a chat does not stay a key to a
 *  real workspace for the whole trial. Normally moot: signing in for real
 *  closes it the moment it happens. */
export const KEEP_GRACE_MS = 7 * 24 * 3600_000;

export type KeepResult =
  | { ok: true; expiresAt: Date; emailed: boolean }
  | { ok: false; reason: "not_sandbox" | "email_taken" };

/** Sends the sign-in link that becomes the way back in, and says whether it
 *  actually went. Injected because the absolute URL comes from the request. */
export type SendKeepLink = (email: string) => Promise<boolean>;

export async function keepSandbox(
  orgId: string,
  userId: string,
  email: string,
  sendKeepLink?: SendKeepLink,
): Promise<KeepResult> {
  const org = await meta
    .selectFrom("orgs")
    .select(["sandbox"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org?.sandbox) return { ok: false, reason: "not_sandbox" };

  const taken = await meta
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .where("id", "!=", userId)
    .executeTakeFirst();
  if (taken) return { ok: false, reason: "email_taken" };

  const expiresAt = new Date(Date.now() + env.TRY_TTL_DAYS * 86_400_000);
  await meta.transaction().execute(async (trx) => {
    await trx.updateTable("users").set({ email }).where("id", "=", userId).execute();
    // No longer a sandbox: the reaper must stop treating it as disposable, and
    // the TTL becomes the account trial's.
    await trx
      .updateTable("orgs")
      .set({ sandbox: false, trial_expires_at: expiresAt })
      .where("id", "=", orgId)
      .execute();
  });

  // Now the way back in. The old link is NOT closed here.
  //
  // The first version revoked it in the same transaction as the promote, on the
  // strength of a comment saying a magic link goes to the address they just
  // gave us - which nothing sent. So keeping a workspace destroyed the only way
  // into it: the open tab kept working, and closing it locked the person out of
  // the thing they had just decided to keep, with no password and no email.
  //
  // Sending the mail first would fix that particular hole and still get the
  // ordering wrong. Someone who has just handed over an address is mid-task:
  // they go and find the email, and the moment the link they are standing on
  // stops working, a delivery delay or a spam folder becomes a locked door.
  // The anonymity is over, but the door should not shut until they are through
  // the other one.
  //
  // So: hold the old link open for a grace window, and close it when they
  // actually sign in for real (see revokeSandboxLinksForUser, called from
  // magic-link consume). The window is a backstop for someone who never comes
  // back - the URL is a bearer token and this workspace is no longer disposable,
  // so it must not stay open for the whole trial.
  await meta
    .updateTable("try_sandbox_tokens")
    .set({ expires_at: new Date(Date.now() + KEEP_GRACE_MS) })
    .where("org_id", "=", orgId)
    .where("revoked_at", "is", null)
    .execute();

  let emailed = false;
  if (sendKeepLink) {
    try {
      emailed = await sendKeepLink(email);
    } catch (err) {
      console.error("[try-sandbox] keep: sign-in link failed to send:", (err as Error).message);
    }
  }
  if (!emailed) {
    console.warn(
      `[try-sandbox] keep: no sign-in email sent for org ${orgId}; ` +
        `the sandbox link is the only way back in and stays open for the grace window`,
    );
  }
  return { ok: true, expiresAt, emailed };
}

// ── the reaper's half ─────────────────────────────────────────────────────

export interface ExpiredSandbox {
  id: string;
  slug: string;
}

/** Sandboxes past their hour. The query itself lives in try-sandbox-query.ts
 *  so the test that guards WHAT GETS DELETED can compile the real statement
 *  without a database. */
export async function expiredSandboxes(limit: number, now: number = Date.now()): Promise<ExpiredSandbox[]> {
  return expiredSandboxesQuery(meta, limit, new Date(now)).execute();
}

/** Best-effort cleanup of token rows whose org is long gone. The FK cascades on
 *  org delete, so this only catches rows orphaned by a partial failure. */
export async function pruneOrphanTokens(): Promise<void> {
  await sql`
    delete from try_sandbox_tokens t
    where not exists (select 1 from orgs o where o.id = t.org_id)
  `.execute(meta);
}

/** Close any still-open sandbox links belonging to a user, because they just
 *  came in through the front door.
 *
 *  This is the other half of the grace window in keepSandbox: the anonymous URL
 *  is meant to stop working once it is no longer the only way in, and a real
 *  sign-in is exactly that moment. Safe to call for anybody - a user who never
 *  had a sandbox matches no rows. */
export async function revokeSandboxLinksForUser(userId: string): Promise<number> {
  const res = await meta
    .updateTable("try_sandbox_tokens")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}
