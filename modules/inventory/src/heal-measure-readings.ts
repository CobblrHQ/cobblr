// One-shot heal: read the measured values of every part made before readings
// existed (migration 0013), so an old "4k7" answers a search for 4.7 kΩ
// without the record being changed.
//
// DONE WHEN: no tenant DB has an inventory_parts row with measures null.
// Check with, per tenant:
//   select count(*) from inventory_parts where measures is null;
// When that is 0 on prod, staging and dev, delete this file and its onBoot
// call. A part made since 0013 starts with '[]' and is read on first use
// (refreshMeasureReadings), so nothing makes new null rows.

import type { Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { InventoryDB } from "./db.js";
import { refreshMeasureReadings } from "./measure-readings.js";

const BATCH = 5000;

/** Heal one workspace; answers how many parts it read. */
export async function healMeasureReadingsIn(orgId: string, db: Kysely<InventoryDB>, since: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await refreshMeasureReadings(db, { limit: BATCH, neverRead: true, madeBefore: since });
    total += n;
    if (n < BATCH) break;
  }
  if (total > 0) console.log(`[inventory] org ${orgId}: read the measured values of ${total} part${total === 1 ? "" : "s"}`);
  return total;
}

/** Call from onBoot. A registered pass: the kernel's walk, budget and
 *  stagger, never a walk of its own at boot. */
export function registerMeasureReadingsHeal(): void {
  registerHealPass({
    name: "inventory.heal-measure-readings",
    since: "2026-10-02T01:22:17Z",
    shim: "modules/inventory/src/heal-measure-readings.ts",
    module: "inventory",
    visit: ({ orgId, db, since }) => healMeasureReadingsIn(orgId, db as Kysely<InventoryDB>, since),
  });
}
