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
//   4. Web client redirects to /me/force-password-reset.
//   5. User PATCHes /me/password with the new one. Server clears
//      the flag (see me.ts:/me/password).
//
// Per [`docs/operations/PRODUCTION_DEPLOY.md`](../../../docs/operations/PRODUCTION_DEPLOY.md)
// this is the recommended onboarding path for the workshop-server
// deploy where wiring SMTP is overkill.

import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { hashPassword } from "../auth/password.js";
import * as activity from "../platform/activity.js";
import { ORG_ROLES } from "@cobblr/platform-contract/org-roles";

export const adminUsersRouter = Router({ mergeParams: true });

const CreateBody = z.object({
  email: z.string().email().max(254),
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
      const email = parsed.data.email.toLowerCase().trim();

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
        const u = await trx
          .insertInto("users")
          .values({
            email,
            password_hash: passwordHash,
            display_name: parsed.data.display_name,
            must_reset_password: true,
            created_by: req.session!.id,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
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
          email,
          display_name: parsed.data.display_name,
          role: parsed.data.role,
          must_reset_password: true,
        },
        temp_password: tempPassword,
        instructions:
          "Hand this password to the user verbally or via a secure channel. They'll be forced to reset it on first login. This password is shown ONCE and never stored in plaintext.",
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
        .select("user_id")
        .where("org_id", "=", req.tenant!.org.id)
        .where("user_id", "=", parsed.data.user_id)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_member", message: "User isn't a member of this workspace." },
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
