// Generic "date custom-field → calendar" source. Any field def of type
// 'date' on a core entity kind (inventory:part / assets:asset) becomes an
// all-day calendar event — so a bundle's renewal / refill / return-by /
// document-expiry / vaccination date lands on the workspace calendar and its
// iCal feed automatically, with NO per-bundle wire.
//
// Platform-level (registered at boot) because it's a cross-cutting calendar
// feature over the field-def system, not any one module's behaviour. It
// references the two core entity tables by name — a pragmatic, documented
// coupling (same as migrate-inventory-locations.ts); the source no-ops when
// the table / module isn't present.

import { sql, type Kysely } from "kysely";
import type { CalendarEvent } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as calendar from "./calendar-registry.js";

interface Spec {
  kind: string;
  table: string;
  entityModule: string;
  entityType: string;
}

const SPECS: Spec[] = [
  { kind: "inventory:part", table: "inventory_parts", entityModule: "inventory", entityType: "part" },
  { kind: "assets:asset", table: "assets_assets", entityModule: "assets", entityType: "asset" },
  { kind: "projects:project", table: "projects_projects", entityModule: "projects", entityType: "project" },
];

// Date fields a DEDICATED source already puts on the calendar — skip them
// here so they don't double up. `expires_on` is owned by lists (the food
// cluster's "X expires" event, in its own colour).
const DEDICATED_FIELDS = new Set(["expires_on"]);

interface DateRow {
  id: string;
  name: string;
  dt: string;
}

export function registerDateFieldCalendarSources(): void {
  for (const spec of SPECS) {
    calendar.registerSource(`${spec.entityModule}-dates`, async (orgId, from, to) => {
      // Date field defs for this module in this workspace — the base kind AND
      // every instance kind (`<instance>:item`). The data query below reads the
      // module's table by metadata key (instance-agnostic), so a date field on
      // a Wardrobe / Warranties / Medications / Outfits instance lands on the
      // calendar just like one on the base kind.
      let defs: { name: string; display_label: string }[];
      try {
        const instances = await meta
          .selectFrom("workspace_module_instances")
          .select(["instance_name"])
          .where("org_id", "=", orgId)
          .where("module_name", "=", spec.entityModule)
          .execute()
          .catch(() => [] as { instance_name: string }[]);
        const kinds = [spec.kind, ...instances.map((i) => `${i.instance_name}:item`)];
        const rawDefs = await meta
          .selectFrom("module_field_defs")
          .select(["name", "display_label"])
          .where("org_id", "=", orgId)
          .where("entity_kind", "in", kinds)
          .where("type", "=", "date")
          .execute();
        // Dedupe by field name (two instances may share a date field name; the
        // data query reads by metadata key, so once per name is enough).
        const seen = new Set<string>();
        defs = rawDefs.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
      } catch {
        return [];
      }
      defs = defs.filter((d) => !DEDICATED_FIELDS.has(d.name));
      if (defs.length === 0) return [];

      let tdb: Kysely<unknown>;
      try {
        tdb = (await getTenantDb(orgId)) as Kysely<unknown>;
      } catch {
        return [];
      }

      const events: CalendarEvent[] = [];
      for (const d of defs) {
        try {
          // Table name comes from the fixed SPECS list (never user input),
          // so sql.raw is safe; the field name is bound as a parameter.
          const compiled = sql<DateRow>`
            select id::text as id, name, (metadata->>${d.name}) as dt
            from ${sql.raw(spec.table)}
            where metadata->>${d.name} is not null
              and (metadata->>${d.name})::date >= ${from}::date
              and (metadata->>${d.name})::date <= ${to}::date
          `.compile(tdb);
          const { rows } = (await tdb.executeQuery(compiled)) as { rows: DateRow[] };
          for (const r of rows) {
            events.push({
              id: `${spec.entityModule}-date:${d.name}:${r.id}:${r.dt.slice(0, 10)}`,
              title: `${r.name} — ${d.display_label}`,
              date: r.dt.slice(0, 10),
              allDay: true,
              source: `${spec.entityModule}-date`,
              category: "date",
              entityModule: spec.entityModule,
              entityType: spec.entityType,
              entityId: r.id,
            });
          }
        } catch (err) {
          // Missing table (module disabled) or a non-date value in the
          // column (bad ::date cast) — skip this field, keep the rest.
          const msg = (err as Error).message;
          if (msg.includes("does not exist") || msg.includes("invalid input syntax")) continue;
          console.error(
            `[calendar] date-field source ${spec.kind}.${d.name} failed:`,
            msg,
          );
        }
      }
      return events;
    });
  }
}
