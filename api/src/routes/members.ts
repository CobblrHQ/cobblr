// Workspace membership management — invites, members list, role
// changes, removal. Scoped to an org. All admin-ish operations
// require the caller to be owner or admin of the org.
//
// Invites are shareable-link tokens. Anyone with the URL who is
// signed in can accept. (No SMTP yet — we don't need email-based
// flow until later.)

import { Router, type Request } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import * as notifications from "../platform/notifications.js";
import { sendAuthEmail, hasAuthEmailSender } from "../platform/hosted-seams.js";
import type { OrgRole } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { buildAuthResponse } from "./auth.js";
import { canActOnRole } from "../auth/capability.js";
import { ORG_ROLES, INVITABLE_ORG_ROLES } from "@cobblr/platform-contract/org-roles";

export const membersRouter = Router({ mergeParams: true });
// /accept-invite/:token doesn't have a tenant slug in the path so it
// rides a separate router that just requires auth.
export const invitesRootRouter = Router();

// ── helpers ──────────────────────────────────────────────────────

const ADMINISH: ReadonlyArray<OrgRole> = ["owner", "admin"];

/** Returns null if caller is admin/owner of the org; otherwise an
 *  error response object the route should emit. */
async function assertAdmin(req: import("express").Request, res: import("express").Response): Promise<boolean> {
  const role = req.tenant!.role as OrgRole;
  // role-gate: exact — managing members is governance, not action. An editor
  // ranks with admin for ACTIONS on purpose, and must not inherit the ability
  // to change who is in the workspace by outranking a member.
  if (!ADMINISH.includes(role)) {
    res.status(403).json({
      error: { code: "forbidden", message: "Workspace owners/admins only." },
    });
    return false;
  }
  return true;
}

function newInviteToken(): string {
  // 24 bytes → 32-char base64url. Crypto-grade.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── GET /:slug/members ───────────────────────────────────────────

membersRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["m.user_id", "u.email", "u.display_name", "m.role", "m.joined_at"])
      .where("m.org_id", "=", req.tenant!.org.id)
      .orderBy("m.joined_at")
      .execute();
    res.json({ items: rows, self: { user_id: req.session!.id, role: req.tenant!.role } });
  } catch (err) {
    next(err);
  }
});

// PATCH /:slug/members/:userId  { role }
const RolePatch = z.object({
  role: z.enum(ORG_ROLES),
});
membersRouter.patch("/:userId", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const parsed = RolePatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const userId = req.params.userId;
    if (!userId) {
      res.status(400).json({ error: { code: "missing_id", message: "userId required" } });
      return;
    }
    // Can't grant a role above your own (audit H2). assertAdmin lets an admin
    // in, but an admin must not be able to set role:"owner" — on anyone,
    // including themselves — and so cross into the owner-only powers.
    if (!canActOnRole(req.tenant!.role, parsed.data.role)) {
      res.status(403).json({
        error: {
          code: "forbidden",
          message: "You can't grant a role higher than your own.",
        },
      });
      return;
    }
    // Look up the TARGET's current role once — it gates two things below.
    const target = await meta
      .selectFrom("org_memberships")
      .select("role")
      .where("org_id", "=", req.tenant!.org.id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    // Can't act on a role above your own either (audit H2 residual). The check
    // above gates the NEW role being granted; this gates the TARGET's CURRENT
    // role — otherwise an admin could demote a sitting owner (bounded only by
    // the last-owner guard, which fires for the LAST owner alone). "admin: can
    // change NON-owner roles" (org-roles.ts) requires BOTH ends actable-on.
    if (target && !canActOnRole(req.tenant!.role, target.role)) {
      res.status(403).json({
        error: {
          code: "forbidden",
          message: "You can't change a member whose role is higher than your own.",
        },
      });
      return;
    }
    // Can't strip the last owner.
    if (parsed.data.role !== "owner" && target?.role === "owner") {
      const ownerCount = await meta
        .selectFrom("org_memberships")
        .select(({ fn }) => fn.countAll<string>().as("c"))
        .where("org_id", "=", req.tenant!.org.id)
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      if (Number(ownerCount.c) <= 1) {
        res.status(400).json({
          error: { code: "last_owner", message: "Can't change the last owner's role." },
        });
        return;
      }
    }
    const updated = await meta
      .updateTable("org_memberships")
      .set({ role: parsed.data.role })
      .where("org_id", "=", req.tenant!.org.id)
      .where("user_id", "=", userId)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Member not found." } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "member_role_changed",
      ref: { module: null, entityType: "membership", entityId: userId },
      diff: { new_role: parsed.data.role },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /:slug/members/:userId — remove member from workspace.
membersRouter.delete("/:userId", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const userId = req.params.userId;
    if (!userId) {
      res.status(400).json({ error: { code: "missing_id", message: "userId required" } });
      return;
    }
    const target = await meta
      .selectFrom("org_memberships")
      .select("role")
      .where("org_id", "=", req.tenant!.org.id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    // Can't remove a member whose role outranks yours (audit H2 residual). The
    // PATCH twin gates the same thing; DELETE had no canActOnRole check at all,
    // so an admin could remove a co-owner (the last-owner guard below only
    // fires for the LAST owner). "admin: can change NON-owner roles" means an
    // admin must not evict an owner either.
    if (target && !canActOnRole(req.tenant!.role, target.role)) {
      res.status(403).json({
        error: {
          code: "forbidden",
          message: "You can't remove a member whose role is higher than your own.",
        },
      });
      return;
    }
    // Don't let admins remove the last owner.
    if (target?.role === "owner") {
      const ownerCount = await meta
        .selectFrom("org_memberships")
        .select(({ fn }) => fn.countAll<string>().as("c"))
        .where("org_id", "=", req.tenant!.org.id)
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      if (Number(ownerCount.c) <= 1) {
        res.status(400).json({
          error: { code: "last_owner", message: "Can't remove the last owner." },
        });
        return;
      }
    }
    const deleted = await meta
      .deleteFrom("org_memberships")
      .where("org_id", "=", req.tenant!.org.id)
      .where("user_id", "=", userId)
      .returning("user_id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "Member not found." } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "member_removed",
      ref: { module: null, entityType: "membership", entityId: userId },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Invites ──────────────────────────────────────────────────────

// Deliver a freshly-minted invite to the invitee: an in-app notification when
// they already have a Cobblr account (so it lands in their bell — the most
// natural surface for an existing user), and an email when an address was given
// (mirrors the notification, and is the only reach for a brand-new person). The
// link is still copied to the inviter's clipboard regardless. Best-effort — never
// fails the mint.
async function deliverInvite(opts: {
  req: Request;
  email: string;
  token: string;
  role: string;
  orgName: string;
  inviterId: string;
  inviteId: string;
  expiresAt: Date;
}): Promise<void> {
  const { req, email, token, role, orgName, inviterId, inviteId, expiresAt } = opts;
  const inviteUrl = `${req.protocol}://${req.get("host") ?? ""}/invite/${token}`;
  const inviter = await meta
    .selectFrom("users")
    .select(["display_name", "email"])
    .where("id", "=", inviterId)
    .executeTakeFirst();
  const inviterName = inviter?.display_name || inviter?.email || "Someone";

  // In-app notification for an existing user. Scoped to one of THEIR own
  // workspaces, because the cross-workspace inbox only surfaces orgs the user is
  // a member of — and they're not in the target workspace yet.
  const invitee = await meta
    .selectFrom("users")
    .select(["id"])
    .where("email", "=", email)
    .executeTakeFirst();
  if (invitee) {
    const home = await meta
      .selectFrom("org_memberships")
      .select("org_id")
      .where("user_id", "=", invitee.id)
      .orderBy("joined_at", "asc")
      .limit(1)
      .executeTakeFirst();
    if (home) {
      await notifications.dispatch({
        orgId: home.org_id,
        userId: invitee.id,
        eventType: "workspace.invited",
        message: `${inviterName} invited you to join "${orgName}".`,
        link_url: `/invite/${token}`,
        entityType: "invite",
        entityId: inviteId,
      });
    }
  }

  // Email — mirrors the notification; the only path for someone with no account.
  if (hasAuthEmailSender()) {
    await sendAuthEmail({
      to: email,
      subject: `${inviterName} invited you to "${orgName}" on Cobblr`,
      text:
        `${inviterName} invited you to join the "${orgName}" workspace on Cobblr as ${role}.\n\n` +
        `Accept the invite:\n  ${inviteUrl}\n\n` +
        `This link expires ${expiresAt.toDateString()}. If you weren't expecting this, you can ignore it.`,
      kind: "notification",
    });
  }
}

const InviteCreate = z.object({
  email: z.string().email().max(255).optional(),
  role: z.enum(INVITABLE_ORG_ROLES).default("member"),
  /** ISO timestamp; defaults to 14 days from now. */
  expires_at: z.string().datetime().optional(),
});

membersRouter.post("/invites", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const parsed = InviteCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    // Can't mint an invite at a role above your own (audit H2). `owner` is
    // already absent from INVITABLE_ORG_ROLES, but an admin still must not
    // hand out anything above admin-tier via a link.
    if (!canActOnRole(req.tenant!.role, parsed.data.role)) {
      res.status(403).json({
        error: {
          code: "forbidden",
          message: "You can't mint an invite for a role higher than your own.",
        },
      });
      return;
    }
    const expiresAt = parsed.data.expires_at
      ? new Date(parsed.data.expires_at)
      : new Date(Date.now() + 14 * 24 * 3600_000);
    const token = newInviteToken();
    const inserted = await meta
      .insertInto("workspace_invites")
      .values({
        org_id: req.tenant!.org.id,
        invited_by_user: req.session!.id,
        token,
        invited_email: parsed.data.email ?? null,
        role: parsed.data.role,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "invite_created",
      ref: { module: null, entityType: "invite", entityId: inserted.id },
      diff: { role: parsed.data.role, email: parsed.data.email ?? null },
    });
    // Notify/email the invitee (fire-and-forget — don't block or fail the mint).
    if (parsed.data.email) {
      void deliverInvite({
        req,
        email: parsed.data.email,
        token,
        role: parsed.data.role,
        orgName: req.tenant!.org.name,
        inviterId: req.session!.id,
        inviteId: inserted.id,
        expiresAt,
      }).catch((e) => console.error("[invites] deliver failed:", (e as Error).message));
    }
    res.status(201).json(inserted);
  } catch (err) {
    next(err);
  }
});

membersRouter.get("/invites", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    // Only open invites by default; ?include=all to see everything.
    const includeAll = req.query.include === "all";
    let q = meta
      .selectFrom("workspace_invites")
      .selectAll()
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("created_at", "desc");
    if (!includeAll) {
      q = q.where("consumed_at", "is", null).where("revoked_at", "is", null);
    }
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

membersRouter.delete("/invites/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const updated = await meta
      .updateTable("workspace_invites")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("org_id", "=", req.tenant!.org.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Open invite not found." } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      action: "invite_revoked",
      ref: { module: null, entityType: "invite", entityId: updated.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── /invites/:token (no tenant context) ──────────────────────────

// GET — public-ish preview: anyone with the token can see workspace
// name + inviter so the accept page can render before clicking.
invitesRootRouter.get("/invites/:token", async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const invite = await meta
      .selectFrom("workspace_invites as i")
      .innerJoin("orgs as o", "o.id", "i.org_id")
      .innerJoin("users as u", "u.id", "i.invited_by_user")
      .select([
        "i.id",
        "i.role",
        "i.invited_email",
        "i.expires_at",
        "i.consumed_at",
        "i.revoked_at",
        "o.name as org_name",
        "o.slug as org_slug",
        "u.display_name as invited_by_name",
      ])
      .where("i.token", "=", token)
      .executeTakeFirst();
    if (!invite) {
      res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
      return;
    }
    const expired = invite.expires_at && new Date(invite.expires_at) < new Date();
    const status = invite.revoked_at
      ? "revoked"
      : invite.consumed_at
      ? "consumed"
      : expired
      ? "expired"
      : "open";
    res.json({ ...invite, status });
  } catch (err) {
    next(err);
  }
});

// POST /invites/:token/accept — must be signed in. Creates a
// membership row for the current user; idempotent if they're
// already a member.
invitesRootRouter.post("/invites/:token/accept", requireAuth, async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const invite = await meta
      .selectFrom("workspace_invites")
      .selectAll()
      .where("token", "=", token)
      .executeTakeFirst();
    if (!invite) {
      res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
      return;
    }
    if (invite.revoked_at) {
      res.status(410).json({ error: { code: "revoked", message: "Invite was revoked." } });
      return;
    }
    if (invite.consumed_at) {
      res.status(410).json({ error: { code: "consumed", message: "Invite already used." } });
      return;
    }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      res.status(410).json({ error: { code: "expired", message: "Invite expired." } });
      return;
    }

    const existing = await meta
      .selectFrom("org_memberships")
      .select("role")
      .where("user_id", "=", req.session!.id)
      .where("org_id", "=", invite.org_id)
      .executeTakeFirst();

    if (!existing) {
      await meta
        .insertInto("org_memberships")
        .values({
          user_id: req.session!.id,
          org_id: invite.org_id,
          role: invite.role,
        })
        .execute();
    }
    await meta
      .updateTable("workspace_invites")
      .set({ consumed_at: new Date(), consumed_by_user: req.session!.id })
      .where("id", "=", invite.id)
      .execute();

    // Activity log inside the workspace, attributed to the joiner.
    try {
      await activity.log({
        orgId: invite.org_id,
        userId: req.session!.id,
        action: existing ? "invite_redeemed_noop" : "member_joined",
        ref: { module: null, entityType: "membership", entityId: req.session!.id },
        diff: { via_invite: invite.id, role: invite.role },
      });
    } catch (err) {
      console.error("[invites] activity log failed:", err);
    }

    const org = await meta
      .selectFrom("orgs")
      .select(["id", "name", "slug"])
      .where("id", "=", invite.org_id)
      .executeTakeFirstOrThrow();
    res.status(201).json({
      org: { ...org, role: existing?.role ?? invite.role },
      already_member: !!existing,
    });
  } catch (err) {
    next(err);
  }
});

// POST /invites/:token/accept-signup — for a brand-new person (NO account
// yet, logged out). The valid workspace-invite token authorises creating an
// account past the public-signup gate, then drops them straight into the
// inviting workspace with the invite's role. The new user gets NO workspace
// of their own — they join the existing one (the collaboration path; cf. the
// signup-invite flow, which instead provisions a fresh workspace).
const AcceptSignup = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(120),
});
invitesRootRouter.post("/invites/:token/accept-signup", async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token) {
      res.status(400).json({ error: { code: "missing_token", message: "token required" } });
      return;
    }
    const parsed = AcceptSignup.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();

    const invite = await meta
      .selectFrom("workspace_invites")
      .selectAll()
      .where("token", "=", token)
      .executeTakeFirst();
    if (!invite) {
      res.status(404).json({ error: { code: "not_found", message: "Invite not found." } });
      return;
    }
    if (invite.revoked_at) { res.status(410).json({ error: { code: "revoked", message: "Invite was revoked." } }); return; }
    if (invite.consumed_at) { res.status(410).json({ error: { code: "consumed", message: "Invite already used." } }); return; }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      res.status(410).json({ error: { code: "expired", message: "Invite expired." } });
      return;
    }
    if (invite.invited_email && invite.invited_email.toLowerCase().trim() !== email) {
      res.status(403).json({ error: { code: "invite_email_mismatch", message: `This invite is for ${invite.invited_email}.` } });
      return;
    }
    // An existing account can't use this path — they should log in and use
    // the regular /accept (which attaches the membership).
    const existing = await meta.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (existing) {
      res.status(409).json({ error: { code: "email_taken", message: "That email already has an account — sign in, then open the invite link to join." } });
      return;
    }

    // Atomically claim the invite (single-use, race-safe) before creating
    // the account, so two redemptions can't both succeed.
    const claimed = await meta
      .updateTable("workspace_invites")
      .set({ consumed_at: new Date() })
      .where("id", "=", invite.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!claimed) {
      res.status(410).json({ error: { code: "consumed", message: "This invite was just used." } });
      return;
    }

    // Create the user (no own-org provisioning) + the membership.
    const password_hash = await hashPassword(parsed.data.password);
    const userRow = await meta
      .insertInto("users")
      .values({ email, password_hash, display_name: parsed.data.display_name.trim() })
      .returning("id")
      .executeTakeFirstOrThrow();
    const userId = userRow.id;
    await meta
      .insertInto("org_memberships")
      .values({ user_id: userId, org_id: invite.org_id, role: invite.role })
      .execute();
    await meta
      .updateTable("workspace_invites")
      .set({ consumed_by_user: userId })
      .where("id", "=", invite.id)
      .execute();

    try {
      await activity.log({
        orgId: invite.org_id,
        userId,
        action: "member_joined",
        ref: { module: null, entityType: "membership", entityId: userId },
        diff: { via_invite: invite.id, role: invite.role, new_account: true },
      });
    } catch (err) {
      console.error("[invites] activity log failed:", err);
    }

    const out = await buildAuthResponse(userId);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

void sql; // re-exported earlier; keep typecheck quiet
