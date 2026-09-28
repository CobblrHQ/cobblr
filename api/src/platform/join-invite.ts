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

export type InviteRow = Pick<
  Selectable<WorkspaceInvitesTable>,
  "id" | "revoked_at" | "consumed_at" | "expires_at" | "reusable" | "max_uses" | "use_count"
>;

export type InviteStatus = "open" | "revoked" | "consumed" | "expired" | "full";

/** Whether an invite can still be used, and if not, why. */
export function inviteStatus(i: InviteRow): InviteStatus {
  if (i.revoked_at) return "revoked";
  if (i.expires_at && new Date(i.expires_at) < new Date()) return "expired";
  if (i.reusable) return i.max_uses !== null && i.use_count >= i.max_uses ? "full" : "open";
  return i.consumed_at ? "consumed" : "open";
}

export const REFUSAL: Record<Exclude<InviteStatus, "open">, string> = {
  revoked: "Invite was revoked.",
  consumed: "Invite already used.",
  expired: "Invite expired.",
  full: "This join link has reached the number of people it was made for. Ask the workspace for a new one.",
};

/** Count one person joining through a join link, atomically and within its
 *  cap. False when the cap was reached between the read and now. */
export async function claimJoinUse(inviteId: string): Promise<boolean> {
  const row = await meta
    .updateTable("workspace_invites")
    .set((eb) => ({ use_count: eb("use_count", "+", 1) }))
    .where("id", "=", inviteId)
    .where("revoked_at", "is", null)
    .where((eb) => eb.or([eb("max_uses", "is", null), eb("use_count", "<", eb.ref("max_uses"))]))
    .returning("id")
    .executeTakeFirst();
  return !!row;
}

export type JoinOutcome =
  | { ok: true; orgId: string; role: OrgRole; alreadyMember: boolean }
  | { ok: false; code: Exclude<InviteStatus, "open">; message: string };

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
  if (status !== "open" && !(invite.reusable && existing && status !== "revoked" && status !== "expired")) {
    return { ok: false, code: status as Exclude<InviteStatus, "open">, message: REFUSAL[status as Exclude<InviteStatus, "open">] };
  }
  if (invite.reusable && !existing && !(await claimJoinUse(invite.id))) {
    return { ok: false, code: "full", message: REFUSAL.full };
  }
  if (!existing) {
    await meta.insertInto("org_memberships").values({ user_id: userId, org_id: invite.org_id, role: invite.role }).execute();
  }
  if (invite.reusable) {
    if (!existing) {
      await meta
        .insertInto("workspace_invite_uses")
        .values({ invite_id: invite.id, user_id: userId, new_account: !!opts.newAccount })
        .execute();
    }
  } else {
    // Clearing declined_at matters: a browser run produced one invite marked
    // BOTH accepted and declined. Accepting is the later, stronger answer, so
    // it erases the earlier no rather than sitting beside it.
    await meta
      .updateTable("workspace_invites")
      .set({ consumed_at: new Date(), consumed_by_user: userId, declined_at: null, declined_by_user: null })
      .where("id", "=", invite.id)
      .execute();
  }
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
    .select(["i.id", "i.token", "i.revoked_at", "i.consumed_at", "i.expires_at", "i.reusable", "i.max_uses", "i.use_count", "o.name as org_name"])
    .where("i.org_id", "=", orgId)
    .where("i.reusable", "=", true)
    .where("i.offer_on_labels", "=", true)
    .where("i.revoked_at", "is", null)
    .orderBy("i.created_at", "desc")
    .execute();
  const open = rows.find((r) => inviteStatus(r) === "open");
  return open ? { token: open.token, org_name: open.org_name } : null;
}
