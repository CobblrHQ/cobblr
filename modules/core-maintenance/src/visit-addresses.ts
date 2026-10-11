// The places service visits went to, offered by the address picker on every
// record (#5317): the MVC a registration renewal was at is the first
// suggestion when the next renewal, or anything else, goes there.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

interface VisitRow {
  name: string;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  address: unknown;
  at: Date | string;
}

/** The newest visits with an address are enough: the picker offers a few. */
const NEWEST = 500;

export function registerVisitAddresses(): void {
  platform().addresses.registerUsedSource("core-maintenance", async (orgId) => {
    const tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    const compiled = sql<VisitRow>`
      select name, entity_module, entity_type, entity_id::text as entity_id, address,
             coalesce(performed_at, scheduled_at, updated_at) as at
      from core_maintenance_entries
      where address is not null
      order by updated_at desc
      limit ${NEWEST}
    `.compile(tdb);
    let rows: VisitRow[];
    try {
      rows = ((await tdb.executeQuery(compiled)) as { rows: VisitRow[] }).rows;
    } catch (err) {
      // A workspace that never turned maintenance on has no visits table.
      if ((err as Error).message.includes("does not exist")) return [];
      throw err;
    }
    return rows.map((r) => ({
      address: r.address,
      // The visit names where it was used ("Registration renewal"); it opens
      // the record it was on.
      usedOn: { kind: `${r.entity_module}:${r.entity_type}`, id: r.entity_id, name: r.name },
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  });
}
