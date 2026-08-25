// THE query for "which workspaces does this user have", used by every endpoint
// that answers it.
//
// It exists because there were two, and they disagreed. `GET /me` selected
// `m.position` and `m.is_default` and ordered by them; the login/signup response
// selected neither and had no ORDER BY at all. A device that had never seen this
// user only ever gets the login response, so on every fresh device:
//
//   • the user's chosen default workspace was invisible (`is_default` undefined),
//   • and the fallback picked the first `role === "owner"` row out of an
//     UNORDERED result set — whatever Postgres happened to return first.
//
// So a new phone or browser opened into an arbitrary old workspace, reproducibly,
// while every device that had been used before was fine (it re-fetched `/me`).
// `o.focused` had the same gap: focused mode did not apply until the first
// refetch after logging in.
//
// One function, so the two answers cannot drift again.

import { meta } from "../db/meta.js";

/** Every field any caller of "my workspaces" needs. Deliberately the UNION of
 *  what the callers used to select separately — an extra column is harmless,
 *  a missing one is the bug above. */
export async function listMembershipsForUser(userId: string) {
  return meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select((eb) => [
      "o.id",
      "o.name",
      "o.slug",
      "o.app_mode",
      "o.focused",
      "o.trial_expires_at",
      "m.role",
      "m.position",
      "m.is_default",
      eb
        .selectFrom("org_memberships as om")
        .innerJoin("users as ou", "ou.id", "om.user_id")
        .select("ou.display_name")
        .whereRef("om.org_id", "=", "o.id")
        .where("om.role", "=", "owner")
        .limit(1)
        .as("owner_name"),
    ])
    .where("m.user_id", "=", userId)
    // The switcher's order, and therefore the order any "first workspace"
    // fallback walks. Without it the client's fallback is non-deterministic.
    .orderBy("m.position", "asc")
    .orderBy("m.joined_at", "asc")
    .execute();
}

/** THE query for "who is a current member of this workspace" — the one the
 *  membership FILTER (@cobblr/platform-contract/membership keepMembers) is fed.
 *
 *  Every workspace-scoped notification path intersects its audience with this:
 *  the platform dispatcher (one recipient) and the discussion module's mention
 *  fan-out + follow rows (many). It exists as one function so those cannot
 *  disagree on who counts — a stranger the filter forgot is a cross-tenant DM. */
export async function orgMemberIds(orgId: string): Promise<Set<string>> {
  const rows = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .execute();
  return new Set(rows.map((r) => String(r.user_id)));
}
