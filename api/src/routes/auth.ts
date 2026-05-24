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

import { Router } from "express";
import { z } from "zod";
import { meta, metaPool } from "../db/meta.js";
import { provisionTenantDb } from "../db/provision.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import * as activity from "../platform/activity.js";
import { enableAllForOrg } from "../modules/enable.js";
import type { OrgRole } from "../db/schema.js";

export const authRouter = Router();

// ─────────────────────────── helpers ────────────────────────────

const SignupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(120),
  org_name: z.string().min(1).max(120),
});

const LoginBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

/** URL-safe slug from a human name. Adds a short random suffix for
 *  collision resistance — we'd rather have `lego-hoard-7k2` than
 *  retry-on-conflict logic on every signup. */
function slugifyWithSuffix(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  const suffix = randomShortId(4);
  return `${base}-${suffix}`;
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
}

interface AuthResponseOrg {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
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
): Promise<{ orgId: string; slug: string; dbName: string }> {
  const dbName = tenantDbName();
  const slug = slugifyWithSuffix(orgName);
  const client = await metaPool.connect();
  let orgId: string;
  try {
    await client.query("begin");
    const orgRow = await client.query<{ id: string }>(
      `insert into orgs (name, slug, db_name)
       values ($1, $2, $3)
       returning id`,
      [orgName.trim(), slug, dbName],
    );
    orgId = orgRow.rows[0]!.id;
    await client.query(
      `insert into org_memberships (user_id, org_id, role)
       values ($1, $2, 'owner')`,
      [userId, orgId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
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
      const enabled = await enableAllForOrg(orgId, userId);
      if (enabled.length > 0) {
        console.log(`[org-provision] auto-enabled modules for ${orgId}: ${enabled.join(", ")}`);
      }
    } catch (err) {
      console.error("[org-provision] auto-enable failed:", err);
    }
    // Default wires for the org get installed transitively when
    // `enableAllForOrg` enables each module — `enableModuleForOrg`
    // iterates `manifest.contributes.wires` and inserts every entry.
    // The backfillDefaultBindings call at boot covers orgs created
    // before a given default wire was added to the manifest.
  }

  return { orgId, slug, dbName };
}

async function buildAuthResponse(userId: string): Promise<AuthResponse> {
  const user = await meta
    .selectFrom("users")
    .select(["id", "email", "display_name"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  const orgs = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.name", "o.slug", "m.role"])
    .where("m.user_id", "=", userId)
    .execute();

  const token = await signSession(userId);
  return { token, user, orgs };
}

// ────────────────────────── POST /signup ─────────────────────────

authRouter.post("/signup", async (req, res, next) => {
  try {
    const body = SignupBody.parse(req.body);
    const email = body.email.toLowerCase().trim();

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

    // Phase 2: provision the user's first org.
    await provisionOrgForUser(userId, body.org_name);

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

    const out = await buildAuthResponse(userId);
    return res.status(201).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: { code: "invalid_body", message: "Bad signup payload", details: err.issues },
      });
    }
    return next(err);
  }
});

// ────────────────────────── POST /login ──────────────────────────

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const email = body.email.toLowerCase().trim();

    const user = await meta
      .selectFrom("users")
      .select(["id", "password_hash", "active"])
      .where("email", "=", email)
      .executeTakeFirst();

    // Same response for "no user" + "wrong password" so we don't
    // leak which emails are registered.
    const denied = () =>
      res.status(401).json({
        error: { code: "invalid_credentials", message: "Email or password incorrect." },
      });

    if (!user || !user.active) return denied();
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) return denied();

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
    const parsed = MagicRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues },
      });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
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
    res.status(202).json({
      ok: true,
      // dev_token only present in non-prod so the test harness can
      // grab it without grepping the meta DB.
      ...(process.env.NODE_ENV !== "production" && { dev_token: plain, dev_link: link }),
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
