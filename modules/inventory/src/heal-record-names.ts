// DONE WHEN: no inventory_parts name holds metadata behind a name
// (nameHoldsMetadata finds none), and no name is what the first cleanup cut
// a creation name down to (damagedByFirstCleanup(created) is no current name
// whose creation name differs), on prod + staging + dev.
// BORN WITH: recordName at create (create-item, POST /parts, core-scan identify; #6283, #6303).
//
// Two passes, one shim.
//
// 1. The Cataloging Bench saved "… SKU: None Brand: Unbranded Category: …" as
//    a tool's name. The doors build a name from real values now; this
//    rebuilds the names saved before, by the same rule (#6283).
// 2. The first version of that rule also cut the words None, null, undefined
//    and NaN wherever they stood, so "None of the Above: Review Edition"
//    became "of the Above: Review Edition" at create, and this heal wrote
//    the same cut onto names saved before it shipped (#6303). The rule no
//    longer matches words. The heal writes no log entry, but a record's
//    creation entry keeps the name it was made with: where the current name
//    is exactly what the first cleanup makes of it, and the creation name is
//    what the rule makes of it now, the creation name goes back. A name a
//    person has changed since is never touched (it is not what the cleanup
//    made). A record made after the first cleanup shipped was cut before its
//    entry was written, so its entry has the cut name too: that title is
//    only the person's to retype.
import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { platform } from "@cobblr/platform-contract";
import { METADATA_LABELS, nameHoldsMetadata, recordName } from "@cobblr/platform-contract/record-name";
import type { InventoryDB } from "./db.js";

/** What the first version of recordName (#6286) made of a name: a label cut
 *  wherever it stood, and the words None, null, undefined and NaN dropped
 *  wherever they stood. Kept only to recognise its damage. */
export function damagedByFirstCleanup(raw: string): string {
  const label = new RegExp(`(^|[\\s,;|(])(${METADATA_LABELS.map((l) => l.replace(/ /g, "\\s+")).join("|")})\\s*:`, "i");
  let s = raw;
  const at = s.search(label);
  if (at >= 0) s = s.slice(0, at);
  s = s.replace(/(^|[\s,;/|(])(none|null|undefined|nan)(?=$|[\s,;/|)])/gi, "$1");
  return s.replace(/\s+/g, " ").replace(/[\s,;:|/(-]+$/, "").replace(/^[\s,;:|/)-]+/, "").trim();
}

/** The name to put back for a record made as `created` and called `current`
 *  now, or null when the cleanup did not make `current`. */
export function restoredName(created: string, current: string): string | null {
  const damaged = damagedByFirstCleanup(created);
  const built = recordName(created);
  if (!built || damaged === built || current !== damaged) return null;
  return built;
}

export async function healRecordNamesIn(db: Kysely<InventoryDB>, since: Date): Promise<number> {
  const rows = await db
    .selectFrom("inventory_parts")
    .select(["id", "name"])
    // A label behind a name has a colon: the one cheap thing every such name holds.
    .where(sql<boolean>`name like '%:%'`)
    .where("created_at", "<", since)
    .execute();
  let healed = 0;
  for (const r of rows) {
    if (!nameHoldsMetadata(r.name)) continue;
    const built = recordName(r.name);
    if (!built || built === r.name) continue;
    await db.updateTable("inventory_parts").set({ name: built, updated_at: new Date() }).where("id", "=", r.id).execute();
    healed += 1;
  }
  return healed;
}

/** Put back the names the first cleanup cut words out of (#6303). */
export async function restoreDamagedNamesIn(orgId: string, db: Kysely<InventoryDB>, since: Date): Promise<number> {
  const made = await platform().activity.createdNamesMatching(orgId, { module: "inventory", entityType: "part", pattern: "(^|[^a-z0-9])(none|null|undefined|nan)([^a-z0-9]|$)" });
  if (!made.length) return 0;
  const now = await db.selectFrom("inventory_parts").select(["id", "name"]).where("id", "in", made.map((m) => m.entityId)).where("created_at", "<", since).execute();
  const byId = new Map(now.map((r) => [r.id, r.name]));
  let restored = 0;
  for (const m of made) {
    const current = byId.get(m.entityId);
    if (current == null) continue;
    const back = restoredName(m.name, current);
    if (!back) continue;
    await db.updateTable("inventory_parts").set({ name: back, updated_at: new Date() }).where("id", "=", m.entityId).execute();
    restored += 1;
  }
  return restored;
}

export function registerRecordNamesHeal() {
  registerHealPass({
    name: "inventory.heal-record-names",
    since: "2026-10-13T21:44:02Z",
    shim: "modules/inventory/src/heal-record-names.ts",
    module: "inventory",
    visit: async ({ orgId, db, since }) => (await healRecordNamesIn(db as Kysely<InventoryDB>, since)) + (await restoreDamagedNamesIn(orgId, db as Kysely<InventoryDB>, since)),
  });
}
