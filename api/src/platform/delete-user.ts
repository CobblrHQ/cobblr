// Delete an account: the person's, or one an operator removes, or one whose
// identity upstream is gone. Shared by DELETE /me, DELETE /super-admin/users/:id
// and POST /auth/identity/deleted. AUTHZ IS THE CALLER'S JOB.
//
// What a deleted account leaves behind: nothing that was the person's. Every
// row that references the user with ON DELETE CASCADE goes first, by asking
// the catalog rather than keeping a list here (a list drifts the day a
// module adds a table); the row itself is then dropped. When something
// without a delete rule still points at it (feedback it filed, an invite it
// created, an operator session it ran: records that are somebody else's
// history as much as theirs), the row stays as an anonymised tombstone
// instead: no email, no name, no password, no identity link, inactive, every
// token invalidated, deleted_at set. Both shapes cannot sign in and cannot be
// handed a workspace by the identity hand-off again (the callback looks the
// identity up by identity_id, which the tombstone no longer carries).
//
// Workspaces: a person who is the only owner of a live workspace is refused
// with the list, so nobody's shared workspace vanishes because one member
// left. The operator and the identity hook pass deleteSoleOwnedWorkspaces,
// which hard-deletes those first, the way the account's own "delete my
// account" upstream says it will.
//
// Found the hard way (#3276): a throwaway account walked through the identity
// hand-off could be removed only by hand-written SQL on two production
// databases, after a permission gate and the owner's say-so. A person could
// delete their workspace through a door; nobody could delete the account.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { hardDeleteOrg } from "./delete-org.js";

export interface SoleOwnedWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** Refused: the person is the only owner of these workspaces. */
export class SoleOwnerRefusal extends Error {
  constructor(public readonly workspaces: SoleOwnedWorkspace[]) {
    super("the account is the only owner of a workspace");
  }
}

export interface DeleteUserResult {
  /** "deleted": the row is gone. "tombstoned": something without a delete rule
   *  still referenced it, so it stays anonymised and inactive. */
  mode: "deleted" | "tombstoned";
  workspaces_deleted: SoleOwnedWorkspace[];
}

/** Workspaces this user owns where no other owner exists. */
export async function soleOwnedWorkspaces(userId: string): Promise<SoleOwnedWorkspace[]> {
  const rows = await sql<SoleOwnedWorkspace>`
    select o.id, o.slug, o.name
    from org_memberships m
    join orgs o on o.id = m.org_id
    where m.user_id = ${userId} and m.role = 'owner'
      and not exists (
        select 1 from org_memberships x
        where x.org_id = m.org_id and x.role = 'owner' and x.user_id <> ${userId}
      )
    order by o.name
  `.execute(meta);
  return rows.rows;
}

/** Every (table, column) that references users(id) with ON DELETE CASCADE,
 *  from the catalog, so the tombstone path clears exactly what a row delete
 *  would have. */
async function cascadingReferences(): Promise<Array<{ table: string; column: string }>> {
  const rows = await sql<{ table: string; column: string }>`
    select tc.table_name as "table", kcu.column_name as "column"
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and ccu.table_name = 'users' and ccu.column_name = 'id'
      and rc.delete_rule = 'CASCADE'
  `.execute(meta);
  return rows.rows;
}

export async function hardDeleteUser(
  userId: string,
  opts: { deleteSoleOwnedWorkspaces?: boolean } = {},
): Promise<DeleteUserResult> {
  const user = await meta.selectFrom("users").select(["id", "email"]).where("id", "=", userId).executeTakeFirst();
  if (!user) throw new Error("user not found");

  const sole = await soleOwnedWorkspaces(userId);
  if (sole.length > 0 && !opts.deleteSoleOwnedWorkspaces) throw new SoleOwnerRefusal(sole);
  for (const w of sole) await hardDeleteOrg(w.id);

  // Nothing can act as this account from here on, whichever shape the end
  // takes: every token dated before now is refused by requireAuth, and an
  // inactive user is refused outright.
  const at = new Date();
  await meta.updateTable("users").set({ active: false, tokens_valid_from: at }).where("id", "=", userId).execute();

  for (const ref of await cascadingReferences()) {
    await sql`delete from ${sql.table(ref.table)} where ${sql.ref(ref.column)} = ${userId}`.execute(meta);
  }

  try {
    await sql`delete from users where id = ${userId}`.execute(meta);
    return { mode: "deleted", workspaces_deleted: sole };
  } catch (err) {
    if ((err as { code?: string }).code !== "23503") throw err;
  }
  // Something without a delete rule still points at the row. Keep the row,
  // remove the person from it.
  const short = userId.replace(/-/g, "").slice(0, 12);
  await meta
    .updateTable("users")
    .set({
      email: `deleted-${short}@deleted.invalid`,
      display_name: "Deleted account",
      // The column is not null; the empty string is the shape the invite
      // path already uses for "no password", and bcrypt rejects it.
      password_hash: "",
      identity_id: null,
      active: false,
      must_reset_password: false,
      tokens_valid_from: at,
      deleted_at: at,
    })
    .where("id", "=", userId)
    .execute();
  return { mode: "tombstoned", workspaces_deleted: sole };
}
