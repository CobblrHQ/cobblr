// One place cannot hold two things with the same name.
//
// "Each rack in Den should have Shelf 1..5" was asked of an assistant against a
// Den where Rack 1 already had a Shelf 1 and a Shelf 2. Sixty creates went
// through unchecked, so Rack 1 ended up with two Shelf 1s and two Shelf 2s and
// the user was told "all done". Nothing in the write path had an opinion about
// it: the assistant was expected to look first, and an assistant that forgets
// leaves the damage behind.
//
// So the rule lives here, under every writer, rather than in a prompt. A second
// "Shelf 1" under the same rack is refused and the caller is told which one is
// already there — including an assistant, which can then say so instead of
// inventing a duplicate. Two bins genuinely both called "Bin" is a real thing
// people have, so `allow_duplicate` gets you through deliberately.
//
// Scoped to SIBLINGS, not the workspace: Rack 1/Shelf 1 and Rack 2/Shelf 1 are
// different shelves and both are correct.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { CoreLocationsDB } from "../db.js";

export interface SiblingRow {
  id: string;
  name: string;
}

/** The existing child of `parentId` that already carries this name, if any.
 *  Case- and whitespace-insensitive: "shelf 1" and "Shelf 1 " are the same
 *  shelf to a person, and a rule people cannot predict is worse than none. */
export async function siblingNamed(
  db: Kysely<CoreLocationsDB>,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<SiblingRow | null> {
  let q = db
    .selectFrom("core_locations_locations")
    .select(["id", "name"])
    .where(sql<boolean>`lower(btrim(name)) = lower(btrim(${name}))`);
  q = parentId === null ? q.where("parent_id", "is", null) : q.where("parent_id", "=", parentId);
  if (exceptId) q = q.where("id", "!=", exceptId);
  const row = await q.executeTakeFirst();
  return row ?? null;
}

export const DUPLICATE_SIBLING = "duplicate_sibling";

/** Said the same way wherever it is refused, because an assistant reads this
 *  string and repeats it to the person who asked. */
export function duplicateSiblingMessage(name: string, placeName: string | null): string {
  const where = placeName ? `"${placeName}"` : "the top level";
  return `${where} already has something called "${name.trim()}", so nothing was created. If you really want a second one, ask again with allow_duplicate.`;
}
