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
//
// THE VALUE IS READ HERE, NOT CAST IN SQL. The query used to cast
// `(metadata->>field)::date` in its WHERE, one query over the whole table.
// A tea box filed by a scan carried Best before "2028-02", Postgres cannot
// cast that, the whole query threw, and the catch below read the throw as
// "no rows": every expiry reminder in that workspace stopped for twelve days
// while the fridge held twenty-five dated groceries (#3279). So the SQL now
// selects the text of every dated row and the ONE rule (field-day.ts) says
// which day each names; a value that names none is returned as unreadable
// for the caller to say so, and it hides nothing else.

import { sql, type Kysely } from "kysely";
import { dateFieldDirection, directionOfRole, dateEventTitle, fieldDay, type CalendarEvent, type DateFieldCalendarSpec } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as calendar from "./calendar-registry.js";
import { facesForKind } from "./faces.js";

type Spec = DateFieldCalendarSpec;

// Date fields a DEDICATED source already puts on the calendar — skip them
// here so they don't double up. `expires_on` is owned by lists (the food
// cluster's "X expires" event, in its own colour).
const DEDICATED_FIELDS = new Set(["expires_on"]);

interface DateRow {
  id: string;
  name: string;
  /** The stored text, as it came. */
  dt: string;
  /** Present when the spec declares `onHand`. */
  on_hand?: string | number | null;
  instance?: string | null;
}

/** A dated row read through the one rule: `day` is what the value names. */
interface ReadDateRow extends DateRow {
  day: string;
}

/** A row whose value is there but names no day. */
export interface UnreadableDateRow {
  id: string;
  name: string;
  value: string;
}

/** Every row of `spec.table` with `field` set, split into the days they name
 *  and the values that name none. The only SQL over the column: no cast, so
 *  no value can throw for the rest. A missing table (module off) is no rows. */
async function readDatedRows(
  tdb: Kysely<unknown>,
  spec: Spec,
  field: string,
): Promise<{ read: ReadDateRow[]; unreadable: UnreadableDateRow[] }> {
  // spec.table is module-declared (never user input) → sql.raw is safe; the
  // field name is bound as a parameter.
  const compiled = sql<DateRow>`
    select id::text as id, name, (metadata->>${field}) as dt${onHandColumns(spec)}
    from ${sql.raw(spec.table)}
    where metadata->>${field} is not null and metadata->>${field} <> ''
  `.compile(tdb);
  let rows: DateRow[];
  try {
    rows = ((await tdb.executeQuery(compiled)) as { rows: DateRow[] }).rows;
  } catch (err) {
    if ((err as Error).message.includes("does not exist")) return { read: [], unreadable: [] };
    throw err;
  }
  const read: ReadDateRow[] = [];
  const unreadable: UnreadableDateRow[] = [];
  for (const r of rows) {
    const day = fieldDay(r.dt);
    if (day === null) unreadable.push({ id: r.id, name: r.name, value: r.dt });
    else read.push({ ...r, day });
  }
  return { read, unreadable };
}

/** The kind a row lives under, from its instance column: the module's own
 *  kind for the default instance, `<instance>:item` for a named one. */
function kindOfRow(spec: Spec, instance: string | null | undefined): string {
  if (!instance || instance === spec.entityModule) return spec.kind;
  return `${instance}:item`;
}

/** Drop rows that have nothing left to date: in a collection with the stock
 *  face and with nothing on hand. Faces are resolved once per kind per call. */
async function withSomethingOnHand<T extends DateRow>(orgId: string, spec: Spec, rows: T[]): Promise<T[]> {
  if (!spec.onHand) return rows;
  const stockByKind = new Map<string, boolean>();
  const out: T[] = [];
  for (const r of rows) {
    const kind = kindOfRow(spec, r.instance);
    let stock = stockByKind.get(kind);
    if (stock === undefined) {
      try {
        stock = (await facesForKind(orgId, kind)).faces.includes("stock");
      } catch {
        stock = false; // unreadable faces: keep the row rather than hide a date
      }
      stockByKind.set(kind, stock);
    }
    const onHand = r.on_hand == null ? null : Number(r.on_hand);
    if (stock && onHand !== null && Number.isFinite(onHand) && onHand <= 0) continue;
    out.push(r);
  }
  return out;
}

/** The extra columns a spec with `onHand` selects, else nothing. */
function onHandColumns(spec: Spec) {
  return spec.onHand
    ? sql.raw(`, ${spec.onHand.column}::text as on_hand, ${spec.onHand.instanceColumn}::text as instance`)
    : sql.raw("");
}

// Specs registered by owning modules (kind → spec), so the kernel can resolve a
// kind's table for queryDateField without the CALLER naming the table.
const specsByKind = new Map<string, Spec>();

/** Kernel-mediated query backing platform().calendar.queryDateField — rows of
 *  `kind` whose date metadata `field` names a day in [fromISO, toISO]. The
 *  table comes from the kind's registered spec; returns [] when the kind/table
 *  is absent. Lets a non-owning module (lists' expiry surfaces) read another
 *  module's dated rows without a raw cross-module table read. A value that
 *  names no day is not here and hides nothing: unreadableDateField lists it. */
export async function queryDateField(
  orgId: string,
  kind: string,
  field: string,
  fromISO: string,
  toISO: string,
): Promise<Array<{ id: string; name: string; value: string }>> {
  const spec = specsByKind.get(kind);
  if (!spec) return [];
  // A pool that will not open is "could not ask", never "nothing dated":
  // read as empty, the expiry sweep reported nothing due for a workspace it
  // never looked at (#3350, the class #3279 was in). Thrown, the sweep's
  // visit fails visibly and the calendar's collect drops this one source.
  const tdb = (await getTenantDb(orgId)) as Kysely<unknown>;
  const { read } = await readDatedRows(tdb, spec, field);
  const inWindow = read.filter((r) => r.day >= fromISO && r.day <= toISO).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return (await withSomethingOnHand(orgId, spec, inWindow)).map((r) => ({ id: r.id, name: r.name, value: r.day }));
}

/** The rows of `kind` whose `field` holds a value that names no day: what a
 *  reader that found nothing due must be able to SAY, so a person can fix
 *  the value rather than wonder why the reminders stopped (#3279). */
export async function unreadableDateField(orgId: string, kind: string, field: string): Promise<UnreadableDateRow[]> {
  const spec = specsByKind.get(kind);
  if (!spec) return [];
  const tdb = (await getTenantDb(orgId)) as Kysely<unknown>;
  return (await readDatedRows(tdb, spec, field)).unreadable;
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
      let defs: { name: string; display_label: string; field_role: string | null }[];
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
          .select(["name", "display_label", "field_role"])
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
          const { read } = await readDatedRows(tdb, spec, d.name);
          const rows = await withSomethingOnHand(orgId, spec, read.filter((r) => r.day >= from && r.day <= to));
          for (const r of rows) {
            events.push({
              id: `${spec.entityModule}-date:${d.name}:${r.id}:${r.day}`,
              title: dateEventTitle(r.name, d.display_label),
              date: r.day,
              allDay: true,
              source: `${spec.entityModule}-date`,
              // The module, not the source id. `inventory-date` was reaching
              // the screen as "INVENTORY-DATE".
              sourceLabel: spec.entityModule,
              // Most custom date fields RECORD something rather than demand it,
              // and a record that has passed is not late. Without this, doing
              // the shopping put five groceries in OVERDUE and pushed anything
              // genuinely late out of sight.
              direction: dateFieldDirection(d.display_label, directionOfRole(d.field_role)),
              category: "date",
              entityModule: spec.entityModule,
              entityType: spec.entityType,
              entityId: r.id,
            });
          }
        } catch (err) {
          // One field's read failing skips that field and keeps the rest; a
          // value that is not a date is never a failure any more (it is read
          // as none by the one rule), so this is a real database error.
          console.error(`[calendar] date-field source ${spec.kind}.${d.name} failed:`, (err as Error).message);
        }
      }
      return events;
    });
  }
}
