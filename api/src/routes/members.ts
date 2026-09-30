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
import { createAccount } from "../platform/accounts.js";
import { sendAuthEmail, hasAuthEmailSender } from "../platform/hosted-seams.js";
import type { OrgRole } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { buildAuthResponse } from "./auth.js";
import { canActOnRole } from "../auth/capability.js";
import { ORG_ROLES, INVITABLE_ORG_ROLES } from "@cobblr/platform-contract/org-roles";
import { REFUSAL, claimJoinUse, inviteStatus, joinThroughInvite } from "../platform/join-invite.js";
import { clearPeopleCache, linkPersonToUser, listPeople, personForUser } from "../platform/people.js";
import { handOffThings, type HandOffResult } from "../platform/person-things.js";

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

export function newInviteToken(): string {
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
    const userId = req.params.userId;
    if (!userId) {
      res.status(400).json({ error: { code: "missing_id", message: "userId required" } });
      return;
    }
    // Anyone may leave a workspace: removing yourself needs no admin, only
    // not being its last owner. Before this a member or guest could not leave
    // at all, since removing a membership was admins' only (2026-09 audit).
    const selfLeave = userId === req.session!.id;
    if (!selfLeave && !(await assertAdmin(req, res))) return;
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
    // admin must not evict an owner either. Leaving is not evicting.
    if (target && !selfLeave && !canActOnRole(req.tenant!.role, target.role)) {
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
          error: {
            code: "last_owner",
            message: selfLeave
              ? "You are this workspace's only owner. Make somebody else an owner first, or delete the workspace."
              : "Can't remove the last owner.",
          },
        });
        return;
      }
    }
    // ?hand_to=<person>: what they own goes to someone else on the People
    // list before they go. Without it their things stay theirs, named and
    // marked as having left, never silently unowned.
    const handTo = typeof req.query.hand_to === "string" && req.query.hand_to ? req.query.hand_to : null;
    let handOff: HandOffResult | null = null;
    if (handTo && target) {
      const orgId = req.tenant!.org.id;
      const leaving = await personForUser(orgId, userId);
      const people = await listPeople(orgId);
      if (!leaving || !people.some((p) => p.id === handTo) || handTo === leaving) {
        res.status(400).json({ error: { code: "bad_hand_to", message: "Hand their things to someone else on this workspace's People list." } });
        return;
      }
      handOff = await handOffThings(orgId, leaving, handTo);
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
    clearPeopleCache(req.tenant!.org.id);
    await activity.log({
      orgId: req.tenant!.org.id,
      ...(selfLeave ? { userId } : {}),
      action: selfLeave ? "member_left" : "member_removed",
      ref: { module: null, entityType: "membership", entityId: userId },
      ...(handOff ? { diff: { handed_to: handTo, moved: handOff.moved, kept: handOff.kept.length } } : {}),
    });
    if (handOff) {
      res.status(200).json(handOff);
      return;
    }
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
export async function deliverInvite(opts: {
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

const InviteCreate = z
  .object({
    email: z.string().email().max(255).optional(),
    role: z.enum(INVITABLE_ORG_ROLES).default("member"),
    /** ISO timestamp; defaults to 14 days from now (a year for a join link). */
    expires_at: z.string().datetime().optional(),
    /** A join link (#3801): anyone holding it may join, many times over,
     *  counted rather than consumed. For a QR on a wall. */
    reusable: z.boolean().optional(),
    /** Stop after this many people have joined through it. */
    max_uses: z.number().int().min(1).max(10_000).optional(),
    /** Item labels offer this join link to someone who scans one signed
     *  out ("Join <workspace> to take one"). Off unless asked for. */
    offer_on_labels: z.boolean().optional(),
    /** At most `limit` people join per `period`; more pauses the link and
     *  tells the admins. A join link gets 10 a day unless it says otherwise;
     *  `pace: null` turns it off. */
    pace: z
      .object({ limit: z.number().int().min(1).max(10_000), period: z.enum(["day", "week", "month", "year"]) })
      .nullable()
      .optional(),
  })
  .refine((v) => !(v.reusable && v.email), { message: "A join link is for anyone who has it, so it names no email." })
  .refine((v) => v.max_uses === undefined || v.reusable, { message: "Only a join link can be used more than once." })
  .refine((v) => !v.offer_on_labels || v.reusable, { message: "Only a join link can be offered from item labels." })
  .refine((v) => !v.pace || v.reusable, { message: "Only a join link has a pace." });

/** A wall QR's default: a burst guard, no total cap, no end date. */
const DEFAULT_JOIN_PACE = { limit: 10, period: "day" as const };

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
    // A join link runs until it is revoked: the pace, not a date, is what
    // stops one that got out. An ordinary invite still lasts two weeks.
    const expiresAt = parsed.data.expires_at
      ? new Date(parsed.data.expires_at)
      : parsed.data.reusable
        ? null
        : new Date(Date.now() + 14 * 24 * 3600_000);
    const pace = parsed.data.reusable ? (parsed.data.pace === undefined ? DEFAULT_JOIN_PACE : parsed.data.pace) : null;
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
        reusable: parsed.data.reusable ?? false,
        max_uses: parsed.data.max_uses ?? null,
        offer_on_labels: parsed.data.offer_on_labels ?? false,
        pace_limit: pace?.limit ?? null,
        pace_period: pace?.period ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "invite_created",
      ref: { module: null, entityType: "invite", entityId: inserted.id },
      diff: { role: parsed.data.role, email: parsed.data.email ?? null, reusable: parsed.data.reusable ?? false, max_uses: parsed.data.max_uses ?? null, offer_on_labels: parsed.data.offer_on_labels ?? false },
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
        // An emailed invite is never a join link, so it always has an end date.
        expiresAt: expiresAt ?? new Date(Date.now() + 14 * 24 * 3600_000),
      }).catch((e) => console.error("[invites] deliver failed:", (e as Error).message));
    }
    // SAY whether a mail went out. A workspace with no mail sender configured
    // (every self-hosted one by default) minted a link, said nothing, and left
    // the admin believing the person had been emailed. The link is right there
    // to copy - the only thing missing was being told to.
    res.status(201).json({
      ...inserted,
      emailed: Boolean(parsed.data.email) && hasAuthEmailSender(),
    });
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
    // Who joined through each join link, newest first: the admin sees every
    // person a wall QR let in, and can remove any of them.
    const reusableIds = items.filter((i) => i.reusable).map((i) => i.id);
    const uses = reusableIds.length
      ? await meta
          .selectFrom("workspace_invite_uses as u")
          .innerJoin("users as p", "p.id", "u.user_id")
          .select(["u.invite_id", "u.user_id", "u.used_at", "p.display_name", "p.email"])
          .where("u.invite_id", "in", reusableIds)
          .orderBy("u.used_at", "desc")
          .execute()
      : [];
    res.json({
      items: items.map((i) =>
        i.reusable
          ? { ...i, joined: uses.filter((u) => u.invite_id === i.id).map((u) => ({ user_id: u.user_id, name: u.display_name || u.email, used_at: u.used_at })) }
          : i,
      ),
    });
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

// A join link that paused itself: turn it back on as it is, or give it a new
// code, which retires the old QR (a photo of it that got out stops working)
// and asks for the new one to be printed. Both are logged.
membersRouter.post("/invites/:id/resume", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const row = await meta
      .updateTable("workspace_invites")
      .set({ paused_at: null, pace_since: new Date() })
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .where("reusable", "=", true)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Join link not found." } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "join_link_resumed",
      ref: { module: null, entityType: "invite", entityId: row.id },
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

membersRouter.post("/invites/:id/rotate", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!(await assertAdmin(req, res))) return;
    const row = await meta
      .updateTable("workspace_invites")
      .set({ token: newInviteToken(), paused_at: null, pace_since: new Date() })
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .where("reusable", "=", true)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Join link not found." } });
      return;
    }
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: "join_link_rotated",
      ref: { module: null, entityType: "invite", entityId: row.id },
    });
    res.json(row);
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
        "i.reusable",
        "i.max_uses",
        "i.use_count",
        "i.paused_at",
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
    res.json({ ...invite, status: inviteStatus(invite) });
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
    const joined = await joinThroughInvite(invite, req.session!.id);
    if (!joined.ok) {
      res.status(410).json({ error: { code: joined.code, message: joined.message } });
      return;
    }
    const org = await meta
      .selectFrom("orgs")
      .select(["id", "name", "slug"])
      .where("id", "=", invite.org_id)
      .executeTakeFirstOrThrow();
    res.status(201).json({
      org: { ...org, role: joined.role },
      already_member: joined.alreadyMember,
    });
  } catch (err) {
    next(err);
  }
});

// POST /invites/:token/decline — the other half of an invite.
//
// Accepting had an endpoint and declining had nothing, so an invite you did not
// want could only be ignored: it sat unread in the bell forever, and the person
// who sent it never learned the answer. "No" is an answer, and a notification
// that can only be dismissed is not actionable (reported 2026-09-06).
//
// Deliberately narrow. It marks the invite declined and does NOT create a
// membership, does not consume the token for anybody else, and does not delete
// the row - the inviter can see it was declined rather than watching it expire
// in silence. Anyone signed in may decline an invite addressed to them, which
// is the same standing `accept` requires; an invite to another address is not
// theirs to answer.
invitesRootRouter.post("/invites/:token/decline", requireAuth, async (req, res, next) => {
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
    // A join link belongs to everybody who has it: one person's "no" is theirs
    // alone and must not close it for the rest of the club.
    if (invite.reusable) {
      res.status(200).json({ declined: true, already_answered: false });
      return;
    }
    // Already answered, one way or the other. Idempotent rather than an error:
    // the button may be tapped twice, and a second "no" is still no.
    if (invite.consumed_at || invite.declined_at) {
      res.status(200).json({ declined: true, already_answered: true });
      return;
    }
    if (invite.revoked_at) {
      res.status(410).json({ error: { code: "revoked", message: "Invite was revoked." } });
      return;
    }
    // An invite addressed to somebody else is not this user's to answer. A
    // token with no email on it is an open link, which anyone holding it may
    // decline for themselves - it costs nobody else their invite.
    if (invite.invited_email) {
      const me = await meta
        .selectFrom("users")
        .select("email")
        .where("id", "=", req.session!.id)
        .executeTakeFirst();
      if ((me?.email ?? "").toLowerCase() !== invite.invited_email.toLowerCase()) {
        res.status(403).json({ error: { code: "not_yours", message: "That invite was sent to someone else." } });
        return;
      }
    }
    await meta
      .updateTable("workspace_invites")
      .set({ declined_at: new Date(), declined_by_user: req.session!.id })
      .where("id", "=", invite.id)
      .execute();
    res.status(200).json({ declined: true, already_answered: false });
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
    const status = inviteStatus(invite);
    if (status !== "open") {
      res.status(410).json({ error: { code: status, message: REFUSAL[status] } });
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

    // Atomically claim the invite before creating the account, so two
    // redemptions cannot both succeed: a single-use invite is consumed, a join
    // link counts one use within its cap.
    if (invite.reusable) {
      const claimed = await claimJoinUse(invite.id);
      if (!claimed.ok) {
        res.status(410).json({ error: { code: claimed.why, message: REFUSAL[claimed.why] } });
        return;
      }
    } else {
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
    }

    // Create the user (no own-org provisioning) + the membership.
    const password_hash = await hashPassword(parsed.data.password);
    const userId = await createAccount(meta, { email, password_hash, display_name: parsed.data.display_name.trim() }, { via: "invite" });
    await meta
      .insertInto("org_memberships")
      .values({ user_id: userId, org_id: invite.org_id, role: invite.role })
      .execute();
    if (invite.reusable) {
      await meta.insertInto("workspace_invite_uses").values({ invite_id: invite.id, user_id: userId, new_account: true }).execute();
    } else {
      await meta
        .updateTable("workspace_invites")
        .set({ consumed_by_user: userId })
        .where("id", "=", invite.id)
        .execute();
    }
    // Invited as someone already on the People list: that entry is now them,
    // so everything that was theirs stays theirs.
    if (invite.person_id) await linkPersonToUser(invite.org_id, invite.person_id, userId);

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
