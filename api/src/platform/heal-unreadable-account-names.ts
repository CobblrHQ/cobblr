// One-shot heal: a person or workspace could be named only spaces or invisible
// characters, which leaves a member row or a workspace switcher row with nothing
// on it to read or press, and a workspace nobody can type the name of to delete.
// Each gets a plain name, so it can be seen and renamed.
//
// DONE WHEN: no users.display_name and no orgs.name lacks something to read.
// /healthz reports the count (noteHealShim, through registerHealPass). When it
// reads 0 on prod, app, try and staging, delete this file and its boot call.
//
// BORN WITH: nothing (every door that names a person or a workspace now refuses
// such a name, through readableNameField).

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { hasSomethingToRead } from "@cobblr/platform-contract/readable-text";
import { sql } from "kysely";
import { meta } from "../db/meta.js";

export const NO_WORKSPACE_NAME = "Unnamed workspace";

/** The part of an address before the @: a member list already shows the address. */
export const nameFromAddress = (email: string) => {
  const local = email.split("@")[0] ?? "";
  return hasSomethingToRead(local) ? local : "Unnamed person";
};

export async function healUnreadableAccountNames(orgId: string, since: Date): Promise<number> {
  let healed = 0;
  const workspace = await meta
    .selectFrom("orgs")
    .select("name")
    .where("id", "=", orgId)
    .where("created_at", "<", since)
    .where(sql<boolean>`name !~ '[[:alnum:]]'`)
    .executeTakeFirst();
  if (workspace && !hasSomethingToRead(workspace.name)) {
    await meta.updateTable("orgs").set({ name: NO_WORKSPACE_NAME }).where("id", "=", orgId).execute();
    healed++;
  }
  const people = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["u.id", "u.email", "u.display_name"])
    .where("m.org_id", "=", orgId)
    .where("u.created_at", "<", since)
    .where(sql<boolean>`u.display_name !~ '[[:alnum:]]'`)
    .execute();
  for (const person of people) {
    if (hasSomethingToRead(person.display_name)) continue;
    await meta.updateTable("users").set({ display_name: nameFromAddress(person.email) }).where("id", "=", person.id).execute();
    healed++;
  }
  return healed;
}

/** Call from boot. A registered pass: the kernel's walk and budget. */
export function registerUnreadableAccountNamesHeal(): void {
  registerHealPass({
    name: "accounts.unreadable-names",
    since: "2026-11-05T11:00:00Z",
    shim: "api/src/platform/heal-unreadable-account-names.ts",
    visit: ({ orgId, since }) => healUnreadableAccountNames(orgId, since),
  });
}
