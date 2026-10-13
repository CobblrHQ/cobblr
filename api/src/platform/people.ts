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
import { normalisePhone } from "../lib/phone.js";
import { ttlCache } from "../lib/ttl-cache.js";
import * as activity from "./activity.js";

export interface WorkspacePerson {
  id: string;
  name: string;
  /** Set when this person is a member, or was one. */
  user_id: string | null;
  email: string | null;
  /** A number to text, in international form (#6070): for an automation's
   *  message to someone outside the workspace. */
  phone: string | null;
  /** In the workspace now. False for someone on the list by name only, and
   *  for a member who has since left (their things are still theirs). */
  member: boolean;
  /** A member who has left: still named, marked so. */
  left: boolean;
}

const TTL_MS = 5_000;
const namesCache = ttlCache<Map<string, string>>(TTL_MS);

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
      "p.phone",
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
      phone: r.phone,
      member,
      left: !!r.user_id && !member,
    };
  });
  return people.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

/** How each entry reads, by id: one query per workspace per TTL, so a list of
 *  200 rows is not 200 lookups. A member who left reads "<name> (left)". */
export async function personNamesFor(orgId: string): Promise<Map<string, string>> {
  return namesCache.get(orgId, async () => {
    let names = new Map<string, string>();
    try {
      const people = await listPeople(orgId, { includeArchived: true });
      names = new Map(people.map((p) => [p.id, p.left ? `${p.name} (left)` : p.name]));
    } catch {
      names = new Map();
    }
    return names;
  });
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

export async function addPerson(orgId: string, input: { name: string; email?: string | null; phone?: string | null }): Promise<WorkspacePerson> {
  const row = await meta
    .insertInto("workspace_people")
    .values({ org_id: orgId, name: input.name.trim(), email: input.email?.trim().toLowerCase() || null, phone: input.phone ?? null, user_id: null })
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

/** The account behind a People entry, when it is a current member's. The
 *  inverse of personForUser, through the same list, so a person who has left
 *  (membership gone) has no account to reach. */
export async function userForPerson(orgId: string, personId: string): Promise<string | null> {
  const person = (await listPeople(orgId)).find((p) => p.id === personId);
  return person?.member && person.user_id ? person.user_id : null;
}

// ── adding and changing someone: the People page, the API and the assistant
// (platform:add-person, platform:edit-person) all come through here.

export type PersonWrite =
  | { ok: true; person: WorkspacePerson }
  | { ok: false; status: number; code: string; message: string; person?: WorkspacePerson };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An email and a phone as given: blank clears, anything else must be one. */
function contactOf(input: { email?: string | null; phone?: string | null }): { email?: string | null; phone?: string | null } | { error: string } {
  const out: { email?: string | null; phone?: string | null } = {};
  if (input.email !== undefined) {
    const e = (input.email ?? "").trim().toLowerCase();
    if (e && (!EMAIL.test(e) || e.length > 255)) return { error: `${input.email} is not an email address.` };
    out.email = e || null;
  }
  if (input.phone !== undefined) {
    const raw = (input.phone ?? "").trim();
    const p = raw ? normalisePhone(raw) : null;
    if (raw && !p) return { error: `${input.phone} is not a phone number in international form: start with + and the country code, like +1 555 010 0123.` };
    out.phone = p;
  }
  return out;
}

export async function createPerson(orgId: string, userId: string, input: { name: string; email?: string | null; phone?: string | null }): Promise<PersonWrite> {
  const name = input.name.trim();
  if (!name || name.length > 120) return { ok: false, status: 400, code: "invalid_body", message: "A person needs a name." };
  const contact = contactOf(input);
  if ("error" in contact) return { ok: false, status: 400, code: "invalid_body", message: contact.error };
  const same = (await listPeople(orgId)).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (same) return { ok: false, status: 409, code: "already_listed", message: `${same.name} is already on the list.`, person: same };
  const person = await addPerson(orgId, { name, email: contact.email ?? null, phone: contact.phone ?? null });
  await activity.log({
    orgId,
    userId,
    action: "person_added",
    ref: { module: null, entityType: "person", entityId: person.id },
    diff: { name: person.name },
  });
  return { ok: true, person };
}

export async function updatePerson(orgId: string, id: string, input: { name?: string; email?: string | null; phone?: string | null }): Promise<PersonWrite> {
  const row = await meta.selectFrom("workspace_people").select(["id", "user_id"]).where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst();
  if (!row) return { ok: false, status: 404, code: "not_found", message: "No such person here." };
  if (row.user_id && input.name !== undefined) return { ok: false, status: 409, code: "member_name", message: "A member's name is their account's; they change it in their own settings." };
  const name = input.name?.trim();
  if (input.name !== undefined && (!name || name.length > 120)) return { ok: false, status: 400, code: "invalid_body", message: "A person needs a name." };
  const contact = contactOf(input);
  if ("error" in contact) return { ok: false, status: 400, code: "invalid_body", message: contact.error };
  const set = { ...(name !== undefined ? { name } : {}), ...contact };
  if (Object.keys(set).length) await meta.updateTable("workspace_people").set(set).where("id", "=", row.id).execute();
  clearPeopleCache(orgId);
  const person = (await listPeople(orgId)).find((p) => p.id === row.id);
  return person ? { ok: true, person } : { ok: false, status: 404, code: "not_found", message: "No such person here." };
}

/** One person by id, or by name as said: exact first, then a part of it. */
export async function findPerson(orgId: string, asked: string): Promise<{ ok: true; person: WorkspacePerson } | { ok: false; message: string }> {
  const all = await listPeople(orgId);
  const byId = all.find((p) => p.id === asked);
  if (byId) return { ok: true, person: byId };
  const want = asked.trim().toLowerCase();
  const exact = all.filter((p) => p.name.toLowerCase() === want);
  const matches = exact.length > 0 ? exact : all.filter((p) => p.name.toLowerCase().includes(want));
  if (matches.length > 1) return { ok: false, message: `More than one person matches "${asked}": ${matches.map((p) => p.name).join(", ")}.` };
  if (!matches[0]) return { ok: false, message: `Nobody called "${asked}" is on this workspace's People list.` };
  return { ok: true, person: matches[0] };
}
