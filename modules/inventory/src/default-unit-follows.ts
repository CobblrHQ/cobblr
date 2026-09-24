// A collection's default count unit, changed by its bundle, reaches the
// records that still carry the old default.
//
// The Yarn table counted in skeins, and nobody knew what a skein was, so its
// bundle now says ball. The bundle's own labels move on update, but a record
// stores the unit it was created with, so every existing yarn would have kept
// saying "skein" on its page and in "Open a skein". The kernel announces the
// change (platform.instance.default-unit-changed, from the bundle apply); this
// module owns the rows and moves only the ones on the OLD default. A record
// someone set to anything else is their choice and is left alone.
//
// ONLY A RENAME. A change between two units that convert into each other
// (Filament's g to kg) is a change of VALUE, and the bundle that makes it
// ships a migration converting each quantity on the rows still in the old
// unit. Relabelling those rows first left 500 g reading 500 kg and the
// migration with nothing to convert (caught by
// api/tests/filament-upgrade-migration.test.ts). So a convertible pair is left
// entirely to the bundle; this follows only a change of word (skein to ball).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "./db.js";

export const DEFAULT_UNIT_CHANGED = "platform.instance.default-unit-changed";

export interface DefaultUnitChanged {
  orgId: string;
  module: string;
  instance: string;
  from: string;
  to: string;
}

/** Move one instance's records from the old default unit to the new one.
 *  Returns how many moved. Case-insensitive on the old unit, since a record
 *  typed "Skein" defaulted just the same. */
export async function followDefaultUnit(db: Kysely<InventoryDB>, change: Omit<DefaultUnitChanged, "orgId" | "module">): Promise<number> {
  const res = await db
    .updateTable("inventory_parts")
    .set({ unit: change.to } as never)
    .where("instance", "=", change.instance as never)
    .where(sql<boolean>`lower(unit) = lower(${change.from})`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

let registered = false;

export function registerDefaultUnitFollows(): void {
  if (registered) return;
  registered = true;
  platform().events.on(DEFAULT_UNIT_CHANGED, "inventory.default-unit-follows", async (raw: unknown) => {
    const p = raw as Partial<DefaultUnitChanged>;
    if (p.module !== "inventory" || !p.orgId || !p.instance || !p.from || !p.to) return;
    const { orgId, instance, from, to } = p;
    // A measure changing its scale is the bundle migration's to convert, never a label to swap.
    if ((await platform().units.convert(orgId, 1, from, to)) !== null) return;
    try {
      const moved = await platform().tenants.withDb(orgId, (raw) => followDefaultUnit(raw as Kysely<InventoryDB>, { instance, from, to }));
      if (moved > 0) console.log(`[inventory] org ${orgId}: ${moved} ${instance} record(s) moved from ${from} to ${to}`);
    } catch (err) {
      console.warn(`[inventory] default unit ${from} -> ${to} for ${instance} not applied:`, (err as Error).message);
    }
  });
}
