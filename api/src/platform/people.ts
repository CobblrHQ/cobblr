// The people a workspace's records can belong to (#3787).
//
// One list per workspace. A member is on it, tied to their account, and their
// name is read from the account so a rename shows everywhere at once. Anyone
// else (the family member, the club member who never signed up, the friend
// whose drill this is) is on it by name. A `person` field stores an entry's
// id, so "Alex" is one person across every item rather than a string that
// drifts ("Alex", "alex", "Alex B."), and inviting Alex later ties the SAME
// entry to the account they make: what was Alex's is still Alex's.
//
// Members get their entry on first read (ensureMemberPeople), not at join:
// every door that makes a member (invite, join link, signup, admin console)
// would otherwise have to remember to, and one that forgot would leave a
// member nobody could pick. Reading reconciles, so none can forget.
//
// Names are workspace data. Nothing here is sent off the instance: a person
// field's stored value is an id, and no barcode or catalog report carries
// custom-field values.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

export interface WorkspacePerson {
  id: string;
  name: string;
  /** Set when this person is a member, or was one. */
  user_id: string | null;
  email: string | null;
  /** In the workspace now. False for someone on the list by name only, and
   *  for a member who has since left (their things are still theirs). */
  member: boolean;
  /** A member who has left: still named, marked so. */
  left: boolean;
}

const TTL_MS = 5_000;
const namesCache = new Map<string, { at: number; names: Map<string, string> }>();

export function clearPeopleCache(orgId?: string): void {
  if (orgId) namesCache.delete(orgId);
  else namesCache.clear();
}

/** Give every current member an entry, once. Idempotent and one statement. */
export async function ensureMemberPeople(orgId: string): Promise<void> {
  await sql`
    insert into workspace_people (org_id, user_id)
    select m.org_id, m.user_id from org_memberships m
    where m.org_id = ${orgId}
      and not exists (select 1 from workspace_people p where p.org_id = m.org_id and p.user_id = m.user_id)
    on conflict do nothing
  `.execute(meta);
}

/** Everyone on the list, members first, by name. */
export async function listPeople(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<WorkspacePerson[]> {
  await ensureMemberPeople(orgId);
  let q = meta
    .selectFrom("workspace_people as p")
    .leftJoin("users as u", "u.id", "p.user_id")
    .leftJoin("org_memberships as m", (j) => j.onRef("m.user_id", "=", "p.user_id").onRef("m.org_id", "=", "p.org_id"))
    .select([
      "p.id",
      "p.name",
      "p.user_id",
      "p.email",
      "u.display_name as account_name",
      "u.email as account_email",
      "m.user_id as member_user",
    ])
    .where("p.org_id", "=", orgId);
  if (!opts.includeArchived) q = q.where("p.archived_at", "is", null);
  const rows = await q.execute();
  const people = rows.map((r) => {
    const member = !!r.member_user;
    const name = (r.user_id ? r.account_name || r.account_email : null) || r.name || r.email || "Someone";
    return {
      id: r.id,
      name,
      user_id: r.user_id,
      email: r.user_id ? (r.account_email ?? r.email) : r.email,
      member,
      left: !!r.user_id && !member,
    };
  });
  return people.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

/** How each entry reads, by id: one query per workspace per TTL, so a list of
 *  200 rows is not 200 lookups. A member who left reads "<name> (left)". */
export async function personNamesFor(orgId: string): Promise<Map<string, string>> {
  const hit = namesCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  let names = new Map<string, string>();
  try {
    const people = await listPeople(orgId, { includeArchived: true });
    names = new Map(people.map((p) => [p.id, p.left ? `${p.name} (left)` : p.name]));
  } catch {
    names = new Map();
  }
  namesCache.set(orgId, { at: Date.now(), names });
  return names;
}

/** The entry for this member, made if they have none yet. */
export async function personForUser(orgId: string, userId: string): Promise<string | null> {
  await ensureMemberPeople(orgId);
  const row = await meta
    .selectFrom("workspace_people")
    .select("id")
    .where("org_id", "=", orgId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function addPerson(orgId: string, input: { name: string; email?: string | null }): Promise<WorkspacePerson> {
  const row = await meta
    .insertInto("workspace_people")
    .values({ org_id: orgId, name: input.name.trim(), email: input.email?.trim().toLowerCase() || null, user_id: null })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  clearPeopleCache(orgId);
  return (await listPeople(orgId)).find((p) => p.id === row.id)!;
}

/**
 * Tie an entry to the account that has just joined through an invite made for
 * it. Every record that names this entry now names the member. When the new
 * member already had an entry of their own (made on a read between joining and
 * now), that empty one gives way: records name the invited entry, and one
 * person must not be two.
 */
export async function linkPersonToUser(orgId: string, personId: string, userId: string): Promise<void> {
  await meta.transaction().execute(async (trx) => {
    const target = await trx
      .selectFrom("workspace_people")
      .select(["id", "user_id"])
      .where("id", "=", personId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!target || (target.user_id && target.user_id !== userId)) return;
    await trx
      .deleteFrom("workspace_people")
      .where("org_id", "=", orgId)
      .where("user_id", "=", userId)
      .where("id", "!=", personId)
      .execute();
    await trx.updateTable("workspace_people").set({ user_id: userId, archived_at: null }).where("id", "=", personId).execute();
  });
  clearPeopleCache(orgId);
}
