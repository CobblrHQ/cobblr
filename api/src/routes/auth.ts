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

    // Phase 1: user + org row + membership in a single transaction.
    // The org row's db_credentials_encrypted stays null at this
    // point — we'll fill it in after the real DB is provisioned in
    // phase 2 below. Either both phases succeed or signup fails.
    const dbName = tenantDbName();
    const client = await metaPool.connect();
    let userId: string;
    let orgId: string;
    try {
      await client.query("begin");
      const userRow = await client.query<{ id: string }>(
        `insert into users (email, password_hash, display_name)
         values ($1, $2, $3)
         returning id`,
        [email, password_hash, body.display_name.trim()],
      );
      userId = userRow.rows[0]!.id;

      const orgRow = await client.query<{ id: string }>(
        `insert into orgs (name, slug, db_name)
         values ($1, $2, $3)
         returning id`,
        [body.org_name.trim(), slugifyWithSuffix(body.org_name), dbName],
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

    // Phase 2: provision the actual tenant Postgres DB + user, run
    // tenant-base migrations, and store the encrypted credentials on
    // the org row. CREATE DATABASE can't run inside a transaction so
    // this can't share the meta-DB tx above.
    //
    // If this step fails, we leave the user + org rows in place but
    // flagged as un-provisioned (db_credentials_encrypted null) — the
    // user can still log in; getting them into a working state
    // becomes an operator concern. (A retry endpoint slots in here
    // once we have one.)
    let provisioned = false;
    try {
      const { credentialsEncrypted, migrationsApplied } = await provisionTenantDb(dbName);
      await meta
        .updateTable("orgs")
        .set({ db_credentials_encrypted: credentialsEncrypted, updated_at: new Date() })
        .where("id", "=", orgId)
        .execute();
      console.log(
        `[signup] provisioned ${dbName} for org ${orgId} (${migrationsApplied} migrations)`,
      );
      provisioned = true;
    } catch (err) {
      console.error(`[signup] FAILED to provision ${dbName}:`, err);
      // Don't fail signup — the user is created and can log in. The
      // op-side surface for re-provisioning will close this gap.
    }

    // Activity log entries for the signup chain. Best-effort —
    // failure to log shouldn't take down the signup response.
    try {
      await activity.log({
        orgId,
        userId,
        action: "user_created",
        ref: { module: null, entityType: "user", entityId: userId },
        diff: { email },
      });
      await activity.log({
        orgId,
        userId,
        action: "org_created",
        ref: { module: null, entityType: "org", entityId: orgId },
        diff: { name: body.org_name, db_name: dbName },
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
      console.error("[signup] activity logging failed:", err);
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
