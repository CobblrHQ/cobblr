// Calendar source: inventory parts with an `expires_on` date (the food
// cluster's expiry field, stored in inventory metadata) become all-day
// events — "milk expires", "leftovers go bad". The expiry concept is owned
// by lists; the data rides on inventory parts, so this reads inventory_parts
// directly and no-ops when inventory isn't enabled (table absent).

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CalendarEvent } from "@cobblr/platform-contract";

interface ExpiringRow {
  id: string;
  name: string;
  expires_on: string;
}

export function registerExpiryCalendarSource(): void {
  platform().calendar.registerSource("expiry", async (orgId, fromISO, toISO) => {
    let tdb: Kysely<unknown>;
    try {
      tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    } catch {
      return [];
    }
    try {
      const compiled = sql<ExpiringRow>`
        select id::text as id, name, (metadata->>'expires_on') as expires_on
        from inventory_parts
        where metadata->>'expires_on' is not null
          and (metadata->>'expires_on')::date >= ${fromISO}::date
          and (metadata->>'expires_on')::date <= ${toISO}::date
        order by (metadata->>'expires_on')::date asc
      `.compile(tdb);
      const { rows } = (await tdb.executeQuery(compiled)) as { rows: ExpiringRow[] };
      return rows.map<CalendarEvent>((r) => ({
        id: `expiry:${r.id}:${r.expires_on}`,
        title: `${r.name} expires`,
        date: r.expires_on.slice(0, 10),
        allDay: true,
        source: "expiry",
        category: "expiry",
        entityModule: "inventory",
        entityType: "part",
        entityId: r.id,
      }));
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("does not exist")) return [];
      throw err;
    }
  });
}
