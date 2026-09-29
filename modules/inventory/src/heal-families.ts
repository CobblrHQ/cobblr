// Heal: a type collection and its things (Filament Types + Spools) left in
// the two shapes a scan used to file them in.
//
// DONE WHEN: no workspace holds either shape below: per tenant, for each
// instance pair (child config `parent.instance`), no type row with
// `metadata ? 'scan_source'` and no `instance-of` pairing pointing at it, and
// no child row with no `instance-of` pairing of its own. Check with
//   select count(*) from inventory_parts t where t.instance = '<type
//   collection>' and t.metadata ? 'scan_source' (then no pairing to it in
//   cobblr_meta.entity_pairings), and the same for untyped child rows.
// When that reads zero on prod, staging and dev, delete this file and its
// boot call. The Filament page itself keeps healing on every read
// (families.ts healFamily), and the scan now files a spool as a spool, so
// nothing re-creates the shapes for a workspace that is used.
//
// What it puts right:
//   - a TYPE row that is really physical things: a scan filed it (it carries
//     `scan_source`, which only the scan writes; a type made by hand or lifted
//     from its things never does) and no thing points at it. It gets as many
//     things under it as it counted (at least one), each with the row's own
//     fields (its size, state, lots, barcode), in the thing collection's unit.
//     A count alone is not the signal: the new-item form gives a typed-in type
//     a count of one.
//   - a THING with no type. It gets its type found or made, by its key fields
//     when it has them all, else by its own name (families.ts typeKey), and is
//     paired to it.
//   - a key field left empty that the record's own name plainly states
//     ("… Silk PLA …, 1.75mm") is filled, and a colour stored as a hex in any
//     spelling (a tag's RGBA, a short hex) is written #rrggbb; a colour NAME
//     is kept as written, since `color` is a key a type is matched by
//     (colour.ts canonicalColour).

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { InventoryDB } from "./db.js";
import { familiesOf, healFamily } from "./api/families.js";

/** Heal one workspace; answers how many records it put right. */
export async function healFamiliesIn(orgId: string, db: Kysely<InventoryDB>): Promise<number> {
  let n = 0;
  for (const fam of await familiesOf(orgId)) n += await healFamily(orgId, db, fam);
  return n;
}

export function registerFamiliesHeal(): void {
  registerHealPass({
    name: "inventory.heal-families",
    shim: "modules/inventory/src/heal-families.ts",
    module: "inventory",
    visit: ({ orgId, db }) => healFamiliesIn(orgId, db as Kysely<InventoryDB>),
  });
}
