// Joining a workspace through an invite, in one place.
//
// Three doors redeem an invite: the signed-in "Join" button, the sign-up form
// on the invite page, and a sign-in link emailed from that page to someone
// without a password (#3801). Each must refuse the same things (revoked,
// expired, used, full) in the same words, count a join link's use within its
// cap exactly once, and let a member who scans the wall QR again straight in
// without counting them. Two copies of that drift, and the half that drifts is
// the one nobody walks, so all three import it from here.
import type { Selectable } from "kysely";
import { meta } from "../db/meta.js";
import type { OrgRole, WorkspaceInvitesTable } from "../db/schema.js";
import * as activity from "./activity.js";
import * as notifications from "./notifications.js";
import { sql } from "kysely";
import { linkPersonToUser } from "./people.js";

export type InviteRow = Pick<
  Selectable<WorkspaceInvitesTable>,
  "id" | "revoked_at" | "consumed_at" | "expires_at" | "reusable" | "max_uses" | "use_count"
> & { paused_at?: Date | null };

export type InviteStatus = "open" | "revoked" | "consumed" | "expired" | "full" | "paused";

/** Whether an invite can still be used, and if not, why. */
export function inviteStatus(i: InviteRow): InviteStatus {
  if (i.revoked_at) return "revoked";
  if (i.expires_at && new Date(i.expires_at) < new Date()) return "expired";
  if (i.reusable && i.paused_at) return "paused";
  if (i.reusable) return i.max_uses !== null && i.use_count >= i.max_uses ? "full" : "open";
  return i.consumed_at ? "consumed" : "open";
}

export const REFUSAL: Record<Exclude<InviteStatus, "open">, string> = {
  revoked: "Invite was revoked.",
  consumed: "Invite already used.",
  expired: "Invite expired.",
  full: "This join link has reached the number of people it was made for. Ask the workspace for a new one.",
  paused: "This join link is paused because more people joined than it allows in a short time. The workspace has been told and can turn it back on.",
};

const PERIOD_WORD: Record<string, string> = { day: "a day", week: "a week", month: "a month", year: "a year" };

/** Count one person joining through a join link, atomically and within its
 *  cap and its pace. "full" when the cap was reached between the read and
 *  now; "paused" when this join would go past the pace, which also pauses the
 *  link and tells the workspace's admins, once. */
export async function claimJoinUse(inviteId: string, db: Pick<typeof meta, "updateTable"> = meta): Promise<{ ok: true } | { ok: false; why: "full" | "paused" }> {
  const row = await db
    .updateTable("workspace_invites")
    .set((eb) => ({ use_count: eb("use_count", "+", 1) }))
    .where("id", "=", inviteId)
    .where("revoked_at", "is", null)
    .where("paused_at", "is", null)
    .where((eb) => eb.or([eb("max_uses", "is", null), eb("use_count", "<", eb.ref("max_uses"))]))
    .where(
      // Parenthesised whole: Kysely ANDs this raw fragment onto the clauses
      // above as written, and a bare OR would escape them, letting the claim
      // match (and count against) some OTHER invite.
      sql<boolean>`(pace_limit is null or pace_period is null or (
        select count(*) from workspace_invite_uses u
        where u.invite_id = workspace_invites.id
          and u.used_at > greatest(
                coalesce(pace_since, '-infinity'::timestamptz),
                now() - (case pace_period when 'day' then interval '1 day' when 'week' then interval '7 days'
                                          when 'month' then interval '1 month' else interval '1 year' end))
      ) < pace_limit)`,
    )
    .returning("id")
    .executeTakeFirst();
  if (row) return { ok: true };
  const inv = await meta
    .selectFrom("workspace_invites")
    .select(["id", "org_id", "max_uses", "use_count", "pace_limit", "pace_period", "paused_at", "revoked_at"])
    .where("id", "=", inviteId)
    .executeTakeFirst();
  if (!inv || inv.revoked_at) return { ok: false, why: "full" };
  if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return { ok: false, why: "full" };
  if (!inv.paused_at && inv.pace_limit !== null && inv.pace_period) await pauseJoinLink(inv.org_id, inv.id, inv.pace_limit, inv.pace_period);
  return { ok: false, why: "paused" };
}

/** Pause a join link that went past its pace, and tell every owner and admin.
 *  Once: a second refusal while it is paused says nothing new. */
async function pauseJoinLink(orgId: string, inviteId: string, limit: number, period: string): Promise<void> {
  const paused = await meta
    .updateTable("workspace_invites")
    .set({ paused_at: new Date() })
    .where("id", "=", inviteId)
    .where("paused_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!paused) return;
  await activity
    .log({
      orgId,
      userId: null,
      action: "join_link_paused",
      ref: { module: null, entityType: "invite", entityId: inviteId },
      diff: { pace_limit: limit, pace_period: period },
    })
    .catch(() => {});
  const members = await meta
    .selectFrom("org_memberships")
    .select(["user_id", "role"])
    .where("org_id", "=", orgId)
    .execute();
  // role-gate: exact — resuming or re-coding a join link is governance, the
  // members page's bar; telling someone who cannot act on it is only noise.
  const admins = members.filter((m) => m.role === "owner" || m.role === "admin");
  for (const a of admins) {
    await notifications
      .dispatch({
        orgId,
        userId: a.user_id,
        eventType: "workspace.join_link_paused",
        message: `Your join link paused itself: more than ${limit} people joined in ${PERIOD_WORD[period] ?? "the period"}. Resume it, or give it a new code if the QR got out.`,
        // The link's own row on the members page, where Resume and New code are.
        // OUTSIDE-RECORD-ADDRESS: an invite is a settings workflow, not a registered record kind.
        link_url: `/configuration/members#invite-${inviteId}`,
        entityType: "invite",
        entityId: inviteId,
      })
      .catch((err) => console.error("[join-link] pause notice failed:", (err as Error).message));
  }
}

export type JoinOutcome =
  | { ok: true; orgId: string; role: OrgRole; alreadyMember: boolean }
  | { ok: false; code: Exclude<InviteStatus, "open"> | "not_yours"; message: string };

/** Make `userId` a member through `invite`, or say why not. A member already
 *  in the workspace is let through a join link (never counted, never refused
 *  by its cap) so the wall QR is also their one-tap way back in. */
export async function joinThroughInvite(
  invite: Selectable<WorkspaceInvitesTable>,
  userId: string,
  opts: { newAccount?: boolean } = {},
): Promise<JoinOutcome> {
  const existing = await meta
    .selectFrom("org_memberships")
    .select("role")
    .where("user_id", "=", userId)
    .where("org_id", "=", invite.org_id)
    .executeTakeFirst();
  const status = inviteStatus(invite);
  // Their own second press, however late: the row said "used" only once their
  // membership had committed with it. Someone removed since isn't let back in.
  if (status === "consumed" && existing && invite.consumed_by_user === userId) {
    return { ok: true, orgId: invite.org_id, role: existing.role as OrgRole, alreadyMember: true };
  }
  if (status !== "open" && !(invite.reusable && existing && status !== "revoked" && status !== "expired")) {
    return { ok: false, code: status as Exclude<InviteStatus, "open">, message: REFUSAL[status as Exclude<InviteStatus, "open">] };
  }
  // A forwarded link must not let someone else in, with the role it was made for
  // (#5365 for shares). The sign-up and sign-in-link doors say this before they
  // make anyone; a signed-in account reaches it here.
  if (!existing && invite.invited_email) {
    const me = await meta.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
    if ((me?.email ?? "").toLowerCase().trim() !== invite.invited_email.toLowerCase().trim()) {
      return { ok: false, code: "not_yours", message: `This invite is for ${invite.invited_email}. Sign in with that address, or ask for a new invite.` };
    }
  }
  // The claim and the membership commit together, and the claim comes first, so
  // two people can't both take a single-use invite and a failed join doesn't spend it.
  const refused = await meta.transaction().execute(async (trx): Promise<{ code: "full" | "paused" | "consumed" } | null> => {
    if (invite.reusable) {
      if (existing) return null;
      // The membership goes first: a double press waits here for the first to
      // commit and finds them in, so it never counts a second use of a capped link.
      const joined = await trx.insertInto("org_memberships").values({ user_id: userId, org_id: invite.org_id, role: invite.role }).onConflict((oc) => oc.columns(["user_id", "org_id"]).doNothing()).returning("user_id").executeTakeFirst();
      if (!joined) return null;
      const claimed = await claimJoinUse(invite.id, trx);
      if (!claimed.ok) {
        await trx.deleteFrom("org_memberships").where("user_id", "=", userId).where("org_id", "=", invite.org_id).execute();
        return { code: claimed.why };
      }
      await trx.insertInto("workspace_invite_uses").values({ invite_id: invite.id, user_id: userId, new_account: !!opts.newAccount }).execute();
      return null;
    }
    // Someone already inside isn't who this invite is for: opening the link to
    // see that it works, or a member given it twice, must leave it for that person.
    if (existing) return null;
    // Clearing declined_at matters: a browser run produced one invite marked
    // BOTH accepted and declined. Accepting is the later, stronger answer, so
    // it erases the earlier no rather than sitting beside it.
    const claimed = await trx
      .updateTable("workspace_invites")
      .set({ consumed_at: new Date(), consumed_by_user: userId, declined_at: null, declined_by_user: null })
      .where("id", "=", invite.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!claimed) return { code: "consumed" };
    await trx.insertInto("org_memberships").values({ user_id: userId, org_id: invite.org_id, role: invite.role }).onConflict((oc) => oc.columns(["user_id", "org_id"]).doNothing()).execute();
    return null;
  });
  if (refused) {
    if (refused.code === "consumed") {
      // Our own double press took it a moment ago: they're in, not refused.
      const now = await meta.selectFrom("workspace_invites").select("consumed_by_user").where("id", "=", invite.id).executeTakeFirst();
      if (now?.consumed_by_user === userId) return { ok: true, orgId: invite.org_id, role: invite.role as OrgRole, alreadyMember: true };
    }
    return { ok: false, code: refused.code, message: REFUSAL[refused.code] };
  }
  // An invite made for someone on the People list: that entry is now this
  // member, so everything that was theirs stays theirs.
  if (invite.person_id && !existing) await linkPersonToUser(invite.org_id, invite.person_id, userId);
  try {
    await activity.log({
      orgId: invite.org_id,
      userId,
      action: existing ? "invite_redeemed_noop" : "member_joined",
      ref: { module: null, entityType: "membership", entityId: userId },
      diff: { via_invite: invite.id, role: invite.role, ...(opts.newAccount ? { new_account: true } : {}) },
    });
  } catch (err) {
    console.error("[invites] activity log failed:", err);
  }
  return { ok: true, orgId: invite.org_id, role: (existing?.role ?? invite.role) as OrgRole, alreadyMember: !!existing };
}

/** The join link this workspace's item labels offer to someone who scans one
 *  signed out: open, not full, and one the admin said labels may offer. The
 *  newest wins when there are several. */
export async function labelJoinLink(orgId: string): Promise<{ token: string; org_name: string } | null> {
  const rows = await meta
    .selectFrom("workspace_invites as i")
    .innerJoin("orgs as o", "o.id", "i.org_id")
    .select(["i.id", "i.token", "i.revoked_at", "i.consumed_at", "i.expires_at", "i.reusable", "i.max_uses", "i.use_count", "i.paused_at", "o.name as org_name"])
    .where("i.org_id", "=", orgId)
    .where("i.reusable", "=", true)
    .where("i.offer_on_labels", "=", true)
    .where("i.revoked_at", "is", null)
    .orderBy("i.created_at", "desc")
    .execute();
  const open = rows.find((r) => inviteStatus(r) === "open");
  return open ? { token: open.token, org_name: open.org_name } : null;
}
