// Who a share is with, as an entry on the owner's People list
// (docs/design-decisions/share-spaces.md §9).
//
// Lending a thing names a person ("Who has it"), and a share with that person
// holds what is lent to them (ScopeDef.lent_to_them). So each share on the
// owner's side is tied to one People entry: the one already there by the
// friend's name when there is one (the person things were lent to before the
// share existed), else a new one. Made when the share goes live, and on the
// first use of a share made before this existed.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { addPerson, listPeople } from "./people.js";

/** The People entry a share is with, made or found on first use. Null for a
 *  share that is not live, or whose person has no name to go by. */
export async function sharePerson(linkId: string): Promise<{ id: string; name: string } | null> {
  const link = await meta.selectFrom("share_links").select(["org_id", "side", "status", "peer_name", "settings"]).where("id", "=", linkId).executeTakeFirst();
  if (!link || link.side !== "owner" || link.status !== "active") return null;
  const said = ((link.settings ?? {}) as { person_id?: unknown }).person_id;
  const people = await listPeople(link.org_id);
  const kept = typeof said === "string" ? people.find((p) => p.id === said) : undefined;
  if (kept) return { id: kept.id, name: kept.name };
  const name = link.peer_name?.trim();
  if (!name) return null;
  const same = people.find((p) => !p.member && p.name.trim().toLowerCase() === name.toLowerCase());
  const person = same ?? (await addPerson(link.org_id, { name }));
  await meta
    .updateTable("share_links")
    .set({ settings: sql`coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ person_id: person.id })}::jsonb` as never })
    .where("id", "=", linkId)
    .execute();
  return { id: person.id, name: person.name };
}
