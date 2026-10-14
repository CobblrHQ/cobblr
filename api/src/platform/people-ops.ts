// Invite someone on the People list to become a member, and hand everything
// one person owns to another: the People screen's own steps (routes/people.ts).
// Both are a person's to do, never an assistant's (human-only.ts, #6528).

import { sendLimitRefusal } from "./send-limits.js";
import { meta } from "../db/meta.js";
import * as activity from "./activity.js";
import { hasAuthEmailSender } from "./hosted-seams.js";
import { clearPeopleCache, listPeople } from "./people.js";
import { handOffThings } from "./person-things.js";
import { deliverInvite, newInviteToken } from "../routes/members.js";

type Refused = { ok: false; status: number; code: string; message: string };

/** Owner or admin, exactly: inviting someone and handing on their things is
 *  governance, the members page's bar, and an editor's rank (equal to an
 *  admin's for actions) does not reach it. The action door checks the rank;
 *  this is the exact rule on top, for every door. */
export async function isOwnerOrAdmin(orgId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const m = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst();
  // role-gate: exact — governance: an editor ranks with admin for actions and must not invite people or hand on their things.
  return m?.role === "owner" || m?.role === "admin";
}

/** Invite a person on the list. An email given is saved on their entry; the
 *  invite is mailed when there is an address and a sender. */
export async function invitePerson(o: { orgId: string; orgName: string; inviterId: string; personId: string; email?: string | null; origin: string }) {
  const person = (await listPeople(o.orgId)).find((p) => p.id === o.personId);
  if (!person) return { ok: false, status: 404, code: "not_found", message: "No such person here." } satisfies Refused;
  if (person.member) return { ok: false, status: 409, code: "already_member", message: `${person.name} is already a member.` } satisfies Refused;
  const email = o.email?.toLowerCase() || person.email || null;
  if (email) {
    const limited = await sendLimitRefusal(o.orgId, "invite");
    if (limited) return { ok: false, status: 429, code: "rate_limited", message: limited } satisfies Refused;
  }
  if (email && email !== person.email) {
    await meta.updateTable("workspace_people").set({ email }).where("id", "=", person.id).execute();
    clearPeopleCache(o.orgId);
  }
  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + 14 * 24 * 3600_000);
  const invite = await meta
    .insertInto("workspace_invites")
    .values({ org_id: o.orgId, invited_by_user: o.inviterId, token, invited_email: email, role: "member", expires_at: expiresAt, person_id: person.id })
    .returningAll()
    .executeTakeFirstOrThrow();
  await activity.log({
    orgId: o.orgId,
    userId: o.inviterId,
    action: "invite_created",
    ref: { module: null, entityType: "invite", entityId: invite.id },
    diff: { role: "member", email, person: person.id },
  });
  if (email) {
    // DETACHED: the invite email; the invite exists and its link is shown to whoever made it
    void deliverInvite({ origin: o.origin, email, token, role: "member", orgName: o.orgName, inviterId: o.inviterId, inviteId: invite.id, expiresAt }).catch((e) =>
      console.error("[people] invite deliver failed:", (e as Error).message),
    );
  }
  return { ok: true as const, invite, person, emailed: Boolean(email) && hasAuthEmailSender(), link: `${o.origin}/invite/${token}` };
}

/** Hand everything one person owns to another on the list. */
export async function handOffPersonThings(o: { orgId: string; userId: string | null; fromId: string; toId: string }) {
  const all = await listPeople(o.orgId, { includeArchived: true });
  const from = all.find((p) => p.id === o.fromId);
  const to = all.find((p) => p.id === o.toId);
  if (!from || !to) return { ok: false, status: 404, code: "not_found", message: "No such person here." } satisfies Refused;
  if (from.id === to.id) return { ok: false, status: 400, code: "same_person", message: "They already own them." } satisfies Refused;
  const limited = await sendLimitRefusal(o.orgId, "hand_off");
  if (limited) return { ok: false, status: 429, code: "rate_limited", message: limited } satisfies Refused;
  const result = await handOffThings(o.orgId, from.id, to.id);
  await activity.log({
    orgId: o.orgId,
    userId: o.userId,
    action: "things_handed_off",
    ref: { module: null, entityType: "person", entityId: from.id },
    diff: { to: to.id, moved: result.moved, kept: result.kept.length },
  });
  return { ok: true as const, from, to, ...result };
}
