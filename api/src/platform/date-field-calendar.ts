// Generic "date custom-field → calendar" source. Any field def of type
// 'date' on a core entity kind (inventory:part / assets:asset) becomes an
// all-day calendar event — so a bundle's renewal / refill / return-by /
// document-expiry / vaccination date lands on the workspace calendar and its
// iCal feed automatically, with NO per-bundle wire.
//
// The GENERIC logic lives here (kernel), but WHICH kinds/tables have date
// fields is no longer hardcoded: each owning module registers its own spec via
// platform().calendar.registerDateFieldSource({ kind, table, … }) at boot, so
// the kernel never names inventory/assets/projects. The owner supplies its own
// table; this helper runs the field-def-driven query against it. The source
// no-ops when the table / module isn't present.
// (Audit 2026-06-26 follow-up — was a hardcoded SPECS list in the kernel.)

import { sql, type Kysely } from "kysely";
import { dateFieldDirection, dateEventTitle, type CalendarEvent, type DateFieldCalendarSpec } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as calendar from "./calendar-registry.js";

type Spec = DateFieldCalendarSpec;

// Date fields a DEDICATED source already puts on the calendar — skip them
// here so they don't double up. `expires_on` is owned by lists (the food
// cluster's "X expires" event, in its own colour).
const DEDICATED_FIELDS = new Set(["expires_on"]);

interface DateRow {
  id: string;
  name: string;
  dt: string;
}

// Specs registered by owning modules (kind → spec), so the kernel can resolve a
// kind's table for queryDateField without the CALLER naming the table.
const specsByKind = new Map<string, Spec>();

/** Kernel-mediated query backing platform().calendar.queryDateField — rows of
 *  `kind` whose date metadata `field` is in [fromISO, toISO]. The table comes
 *  from the kind's registered spec; returns [] when the kind/table is absent.
 *  Lets a non-owning module (lists' expiry surfaces) read another module's
 *  dated rows without a raw cross-module table read. (Audit burn-down.) */
export async function queryDateField(
  orgId: string,
  kind: string,
  field: string,
  fromISO: string,
  toISO: string,
): Promise<Array<{ id: string; name: string; value: string }>> {
  const spec = specsByKind.get(kind);
  if (!spec) return [];
  let tdb: Kysely<unknown>;
  try {
    tdb = (await getTenantDb(orgId)) as Kysely<unknown>;
  } catch {
    return [];
  }
  try {
    // spec.table is module-declared (never user input) → sql.raw is safe; the
    // field name + dates are bound as parameters.
    const compiled = sql<DateRow>`
      select id::text as id, name, (metadata->>${field}) as dt
      from ${sql.raw(spec.table)}
      where metadata->>${field} is not null
        and (metadata->>${field})::date >= ${fromISO}::date
        and (metadata->>${field})::date <= ${toISO}::date
      order by (metadata->>${field})::date asc
    `.compile(tdb);
    const { rows } = (await tdb.executeQuery(compiled)) as { rows: DateRow[] };
    return rows.map((r) => ({ id: r.id, name: r.name, value: r.dt }));
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("does not exist") || msg.includes("invalid input syntax")) return [];
    throw err;
  }
}

/** Register the generic date-field calendar source for ONE owning module's
 *  kind. Idempotent per source id. Called from the module's boot via
 *  platform().calendar.registerDateFieldSource(spec). */
export function registerDateFieldSource(spec: Spec): void {
  specsByKind.set(spec.kind, spec);
  {
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
              title: dateEventTitle(r.name, d.display_label),
              date: r.dt.slice(0, 10),
              allDay: true,
              source: `${spec.entityModule}-date`,
              // The module, not the source id. `inventory-date` was reaching
              // the screen as "INVENTORY-DATE".
              sourceLabel: spec.entityModule,
              // Most custom date fields RECORD something rather than demand it,
              // and a record that has passed is not late. Without this, doing
              // the shopping put five groceries in OVERDUE and pushed anything
              // genuinely late out of sight.
              direction: dateFieldDirection(d.display_label),
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
