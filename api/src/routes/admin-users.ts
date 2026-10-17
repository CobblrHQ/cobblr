// Admin-creates-user — the no-email onboarding flow.
//
// The flow:
//   1. Admin / workspace owner POSTs /orgs/:slug/admin/users with
//      email + display_name + role. We mint a strong random
//      temp password, hash it, insert the user, attach a membership
//      on the workspace, and return the plaintext password ONCE.
//   2. Admin hands the user their (email + temp password) verbally
//      / on paper / in chat. No SMTP needed.
//   3. User logs in with those credentials. Login response carries
//      `user.must_reset_password = true`.
//   4. Web client renders the set-a-password screen in place of every
//      route (a gate, not a URL - nothing to navigate around).
//   5. User PATCHes /me/password with the new one. Server clears
//      the flag (see me.ts:/me/password).
//
// Per [`docs/operations/PRODUCTION_DEPLOY.md`](../../../docs/operations/PRODUCTION_DEPLOY.md)
// this is the recommended onboarding path for the workshop-server
// deploy where wiring SMTP is overkill.

import { env } from "../env.js";
import { isUndeliverableAddress, normalizeUsername, placeholderEmail, usernameProblem } from "../platform/usernames.js";
import { Router } from "express";
import { z } from "zod";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { createAccount } from "../platform/accounts.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { hashPassword } from "../auth/password.js";
import * as activity from "../platform/activity.js";
import { ORG_ROLES } from "@cobblr/platform-contract/org-roles";
import { canActOnRole } from "../auth/capability.js";
import { makeIpLimiter, rateLimited } from "../platform/ip-limiter.js";
import { MEMBER_PAIR_CODE_TTL_MS, mintPairCode, pairMintRefusal, revokeMemberPairCodes } from "../platform/pair-codes.js";

export const adminUsersRouter = Router({ mergeParams: true });

const CreateBody = z.object({
  // Required, unless the operator allows accounts with only a username (#6910).
  email: optionalField(z.string().email().max(254)),
  // An optional name to sign in with beside the email (#6910).
  username: optionalField(z.string().trim().max(64)),
  display_name: z.string().min(1).max(120),
  role: z.enum(ORG_ROLES).default("member"),
});

const RegenPasswordBody = z.object({
  user_id: z.string().uuid(),
});

/** Generate a memorable temp password. Three random 4-character
 *  alphanumeric groups joined by hyphens — readable over the phone,
 *  typeable, and >60 bits of entropy. Excludes ambiguous chars
 *  (0/O, 1/l/I). */
function generateTempPassword(): string {
  const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O, I, 0, 1
  const group = () =>
    Array.from(randomBytes(4))
      .map((b) => ALPHA[b % ALPHA.length])
      .join("");
  return `${group()}-${group()}-${group()}`;
}

// POST /orgs/:slug/admin/users — admin creates an account + adds it
// to this workspace in one call. Returns the temp password ONCE so
// the admin can copy + hand it off. The password isn't stored
// anywhere in plaintext.
adminUsersRouter.post(
  "/:slug/admin/users",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // role-gate: exact — minting an account or resetting somebody's password
      // is membership governance; an editor does not inherit it by rank.
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      // Can't mint an account at a role above your own (audit H2). Only an
      // owner may create an `owner`; an admin is capped at admin/editor and
      // below. Without this, an admin could create an owner and inherit the
      // owner-only powers (delete workspace, rename, app-mode lock).
      if (!canActOnRole(req.tenant!.role, parsed.data.role)) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "You can't create a user at a role higher than your own.",
          },
        });
        return;
      }
      const username = parsed.data.username ? normalizeUsername(parsed.data.username) : null;
      if (username !== null) {
        const problem = usernameProblem(username);
        if (problem) {
          res.status(400).json({ error: { code: "invalid_username", message: problem } });
          return;
        }
        if (await meta.selectFrom("users").select("id").where("username", "=", username).executeTakeFirst()) {
          res.status(409).json({ error: { code: "username_taken", message: "That username is taken." } });
          return;
        }
      }
      if (!parsed.data.email && !(env.COBBLR_USERNAME_ONLY_ACCOUNTS && username)) {
        res.status(400).json({
          error: {
            code: "email_required",
            message: env.COBBLR_USERNAME_ONLY_ACCOUNTS ? "Give an email or a username." : "Give the person's email. (An account with only a username needs the server's COBBLR_USERNAME_ONLY_ACCOUNTS turned on.)",
          },
        });
        return;
      }
      // No email: an address nothing is ever sent to, so a forgotten password
      // is reset by an admin here (#6910).
      const email = parsed.data.email ? parsed.data.email.toLowerCase().trim() : placeholderEmail(username!);

      // Refuse to re-create an existing user. If the email already
      // exists, the admin should either invite them via /invites or
      // reset their password (different endpoint).
      const existing = await meta
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst();
      if (existing) {
        res.status(409).json({
          error: {
            code: "email_taken",
            message:
              "A user with this email already exists. Use /invites to add an existing user to a workspace, or /admin/users/:id/regen-password to reset their password.",
          },
        });
        return;
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);

      // Insert + attach to workspace in one transaction so we can't
      // end up with a created-but-unattached user.
      const userId = await meta.transaction().execute(async (trx) => {
        const u = {
          id: await createAccount(
            trx,
            {
              email,
              username,
              password_hash: passwordHash,
              display_name: parsed.data.display_name,
              must_reset_password: true,
              created_by: req.session!.id,
            },
            { via: "admin", byUserId: req.session!.id },
          ),
        };
        await trx
          .insertInto("org_memberships")
          .values({
            org_id: req.tenant!.org.id,
            user_id: u.id,
            role: parsed.data.role,
          })
          .execute();
        return u.id;
      });

      await activity
        .log({
          orgId: req.tenant!.org.id,
          userId: req.session!.id,
          action: "user_minted",
          ref: { module: null, entityType: "user", entityId: userId },
          diff: { email, role: parsed.data.role },
        })
        .catch((err) => console.error("[admin-users] activity log failed:", err));

      res.status(201).json({
        user: {
          id: userId,
          email: isUndeliverableAddress(email) ? null : email,
          username,
          display_name: parsed.data.display_name,
          role: parsed.data.role,
          must_reset_password: true,
        },
        temp_password: tempPassword,
        instructions:
          "Hand this password to the user verbally or via a secure channel. They'll be forced to reset it on first login. This password is shown ONCE and never stored in plaintext." +
          (isUndeliverableAddress(email) ? " This account has no email: they sign in with their username, and if they forget the password an admin resets it here." : ""),
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /orgs/:slug/admin/users/:user_id/regen-password — mint a new
// temp password for an existing user. Useful when they've locked
// themselves out + no email reset flow exists. Forces must_reset.
adminUsersRouter.post(
  "/:slug/admin/users/regen-password",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // role-gate: exact — minting an account or resetting somebody's password
      // is membership governance; an editor does not inherit it by rank.
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const parsed = RegenPasswordBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      // Verify the target user is actually a member of this workspace.
      // Admins from workspace A can't reset workspace B users.
      const member = await meta
        .selectFrom("org_memberships")
        .select(["user_id", "role"])
        .where("org_id", "=", req.tenant!.org.id)
        .where("user_id", "=", parsed.data.user_id)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_member", message: "User isn't a member of this workspace." },
        });
        return;
      }
      // Can't reset the password of someone who outranks you (audit H2). Only
      // an owner may reset an owner — otherwise an admin could rotate the
      // owner's password (shown once) and log in as them.
      if (!canActOnRole(req.tenant!.role, member.role)) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "You can't reset the password of a member who outranks you.",
          },
        });
        return;
      }
      const tempPassword = generateTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      await meta
        .updateTable("users")
        .set({ password_hash: passwordHash, must_reset_password: true })
        .where("id", "=", parsed.data.user_id)
        .execute();
      await activity
        .log({
          orgId: req.tenant!.org.id,
          userId: req.session!.id,
          action: "password_reset_by_admin",
          ref: { module: null, entityType: "user", entityId: parsed.data.user_id },
        })
        .catch((err) => console.error("[admin-users] activity log failed:", err));
      res.json({
        temp_password: tempPassword,
        instructions:
          "Hand this password to the user. They'll be forced to reset it on first login.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Sign a member's phone in (#6692) ────────────────────────────────────
//
// A worker who was added here and has never typed a password scans a QR the
// admin shows and is signed in on their phone, as themselves, with their own
// role: the pair code of /auth/pair/start, minted by the admin for one named
// member. Bounded so it can never become a way into someone else's account:
// only a member whose ONLY workspace is this one (an admin here must not be
// able to sign in as someone who also belongs elsewhere), never someone who
// outranks the admin, never the admin themselves (their own phone pairs from
// their own menu), and only by a person signed in themselves (never a token,
// so no assistant or MCP client can mint one: HUMAN_ONLY_ACTIONS names it).
// Single use, ten minutes, the last code voided by a new one or by Revoke.

const MemberPairBody = z.object({ user_id: z.string().uuid() });
const memberPairLimiter = makeIpLimiter(60_000, 20);

async function memberPairTarget(
  req: import("express").Request,
  res: import("express").Response,
): Promise<{ userId: string; displayName: string } | null> {
  const refusal = pairMintRefusal(req.session!);
  if (refusal) {
    res.status(403).json({ error: { code: "session_required", message: refusal } });
    return null;
  }
  const parsed = MemberPairBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "Say whose phone: user_id." } });
    return null;
  }
  const userId = parsed.data.user_id;
  if (userId === req.session!.id) {
    res.status(400).json({ error: { code: "own_phone", message: "To sign in your own phone, use Pair phone from your own menu." } });
    return null;
  }
  const member = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.role", "u.active", "u.display_name", "u.email"])
    .where("m.org_id", "=", req.tenant!.org.id)
    .where("m.user_id", "=", userId)
    .executeTakeFirst();
  if (!member || !member.active) {
    res.status(404).json({ error: { code: "not_member", message: "That person isn't a member of this workspace." } });
    return null;
  }
  if (!canActOnRole(req.tenant!.role, member.role)) {
    res.status(403).json({ error: { code: "forbidden", message: "You can't sign in someone who outranks you." } });
    return null;
  }
  const elsewhere = await meta
    .selectFrom("org_memberships")
    .select("org_id")
    .where("user_id", "=", userId)
    .where("org_id", "!=", req.tenant!.org.id)
    .executeTakeFirst();
  if (elsewhere) {
    res.status(403).json({
      error: {
        code: "member_elsewhere",
        message: "This person also belongs to another workspace, so only they can sign their phone in: from Pair phone in their own menu.",
      },
    });
    return null;
  }
  return { userId, displayName: member.display_name || member.email };
}

// POST /orgs/:slug/admin/users/pair-code — a QR that signs this member's phone in.
// UI-SCREEN: /configuration/permissions (Accounts: Sign in their phone)
adminUsersRouter.post("/:slug/admin/users/pair-code", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!memberPairLimiter(req.ip ?? "unknown")) {
      rateLimited(res);
      return;
    }
    // role-gate: exact — signing someone in is membership governance, like minting their account.
    if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
      res.status(403).json({ error: { code: "forbidden", message: "Admins only." } });
      return;
    }
    const target = await memberPairTarget(req, res);
    if (!target) return;
    const minted = await mintPairCode(req, {
      userId: target.userId,
      orgSlug: req.tenant!.org.slug,
      mintedBy: req.session!.id,
      ttlMs: MEMBER_PAIR_CODE_TTL_MS,
    });
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "phone_sign_in_code_minted",
      ref: { module: null, entityType: "user", entityId: target.userId },
      diff: { for: target.displayName, expires_at: minted.expires_at },
    });
    res.status(201).json({ ...minted, for: target.displayName });
  } catch (err) {
    next(err);
  }
});

// POST /orgs/:slug/admin/users/pair-code/revoke — void this member's live codes.
// UI-SCREEN: /configuration/permissions (Accounts: Sign in their phone, Cancel the code)
adminUsersRouter.post("/:slug/admin/users/pair-code/revoke", requireAuth, withTenant, async (req, res, next) => {
  try {
    // role-gate: exact — signing someone in is membership governance, like minting their account.
    if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
      res.status(403).json({ error: { code: "forbidden", message: "Admins only." } });
      return;
    }
    const target = await memberPairTarget(req, res);
    if (!target) return;
    const revoked = await revokeMemberPairCodes(target.userId, req.tenant!.org.slug);
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "phone_sign_in_code_revoked",
      ref: { module: null, entityType: "user", entityId: target.userId },
      diff: { for: target.displayName, revoked },
    });
    res.json({ revoked });
  } catch (err) {
    next(err);
  }
});
