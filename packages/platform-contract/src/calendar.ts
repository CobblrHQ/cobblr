import type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";
import type { OverdueRow, OverdueSource } from "@cobblr/platform-contract/overdue-and-addresses";

/** One dated thing on the workspace calendar — a scheduled maintenance
 *  entry, a task due date, a food item's expiry. Contributed by a module's
 *  CalendarSource; aggregated by core-calendar for the in-app month view
 *  and the iCal feed. */
export interface CalendarEvent {
  /** Stable within a source across reads — used as the iCal UID and the
   *  React key. Convention: `<source>:<entityId>:<yyyy-mm-dd>`. */
  id: string;
  title: string;
  /** ISO date ("2026-06-10") for all-day, or ISO datetime for timed. */
  date: string;
  allDay?: boolean;
  /** The contributing source's id (e.g. "maintenance", "task", "expiry"). A
   *  machine key: matched on for colour/grouping, never shown. */
  source: string;
  /** What to CALL the source on screen. Without it the raw id leaks: a
   *  dashboard row read "Roma Tomatoes - Bought on  INVENTORY-DATE". */
  sourceLabel?: string;
  /** Whether passing this date means something is late. Absent is read as a
   *  deadline, which is right for the dedicated sources (maintenance, tasks,
   *  expiry) - they only ever emit deadlines. The generic date-field source
   *  says explicitly, because most custom date fields record rather than
   *  demand. See date-field-direction.ts. */
  direction?: DateFieldDirection;
  /** Coarse category for colour/grouping (often == source). */
  category?: string;
  /** Deep-link back to the originating entity, when there is one. */
  entityModule?: string;
  entityType?: string;
  entityId?: string;
  detailUrl?: string;
  /** Where it happens, as one line ("MVC Lodi Agency, 8 Mill St, Lodi, NJ"):
   *  the feed's LOCATION, so a phone's calendar shows it and offers
   *  directions, and the in-app calendar's "Where". From the record's address
   *  field (@cobblr/platform-contract/address addressText). */
  location?: string;
  /** The address's coordinates, when it has some: the feed's GEO. */
  geo?: { lat: number; lon: number };
}

/** A module's contribution of dated events for a window. Called with an
 *  inclusive [fromISO, toISO] date range; returns the events in it.
 *  Best-effort: a throw is swallowed and that source contributes nothing. */
export type CalendarSource = (
  orgId: string,
  fromISO: string,
  toISO: string,
) => Promise<CalendarEvent[]>;

/** D? — workspace calendar. Modules register a source of dated events;
 *  core-calendar aggregates every registered source for the in-app month
 *  view + the tokenised iCal feed.
 *
 *  Example (in modules/core-maintenance):
 *    platform().calendar.registerSource("maintenance", async (orgId, from, to) => {
 *      // query scheduled, not-yet-done entries in [from,to]
 *      return rows.map((r) => ({ id: ..., title: r.name, date: r.scheduled_at, ... }));
 *    }); */
/** What an entity-owning module passes to register the generic "date
 *  custom-field → calendar" source for its kind. The owner supplies its OWN
 *  table; the kernel runs the generic field-def-driven query (every type='date'
 *  field on the kind + its instance kinds becomes an all-day event). Moves the
 *  table/module knowledge OUT of the kernel and INTO the owning module.
 *  (Audit 2026-06-26 follow-up — was a hardcoded SPECS list in the kernel.) */
export interface DateFieldCalendarSpec {
  /** Base entity kind, e.g. "inventory:part". */
  kind: string;
  /** The module's own table for that kind, e.g. "inventory_parts". */
  table: string;
  /** Module name for the event source/category, e.g. "inventory". */
  entityModule: string;
  /** Entity type for the event payload, e.g. "part". */
  entityType: string;
  /** The table's column that says which collection (instance) a row is in.
   *  Default "instance", which every dated table has. */
  instanceColumn?: string;
  /** The columns that say how much of a record is on hand and which
   *  collection it is in. A record of a collection with the STOCK face and
   *  nothing on hand has nothing left to date: the kernel leaves its date
   *  fields off the calendar and out of queryDateField, so exhausted milk is
   *  never "expired 5d ago" on the day it is bought again. A collection
   *  without the stock face (a bookshelf, where the count is not the point)
   *  keeps every date. Omit and every row counts. */
  onHand?: { column: string; instanceColumn: string };
  /** Built-in date columns, declared by their owner, with a separate filter. */
  dateColumns?: Array<{
    column: string;
    label: string;
    source: "warranty" | "purchase";
    direction: DateFieldDirection;
    /** A true flag, such as a lifetime warranty, removes this date. */
    excludeWhen?: string;
  }>;

}

/** Who a calendar source answers to: the module that registers it, and its
 *  part where it belongs to one. A workspace that has turned that module (or
 *  part) off gets nothing from the source, and the source is not even called:
 *  the module's records stay, its dates leave the calendar and the feed
 *  (#7160). Required, so a source cannot be added that nobody can switch off. */
export interface CalendarSourceOwner {
  /** The owning module's name ("projects"), or "platform" for the kernel's own. */
  module: string;
  part?: string;
}

export interface PlatformCalendar {
  registerSource(id: string, source: CalendarSource, owner: CalendarSourceOwner): void;
  /** Register the generic date-custom-field calendar source for an entity kind.
   *  Called by the OWNING module at boot (e.g. inventory for inventory:part),
   *  so the kernel never hardcodes which modules/tables have date fields. */
  registerDateFieldSource(spec: DateFieldCalendarSpec): void;
  /** Run every registered source for the window and return the merged,
   *  date-sorted events. Sources that throw contribute nothing. */
  collect(orgId: string, fromISO: string, toISO: string): Promise<CalendarEvent[]>;
  /** Kernel-mediated query: rows of `kind` whose date metadata field `field`
   *  falls in [fromISO, toISO]. The table is resolved from the kind's
   *  registerDateFieldSource spec, so a CALLER (e.g. lists surfacing grocery
   *  expiry) reads another module's dated rows WITHOUT naming its table. Returns
   *  [] when the kind isn't registered or its table is absent. (Audit burn-down:
   *  replaces lists' raw `from inventory_parts` reads.) */
  queryDateField(
    orgId: string,
    kind: string,
    field: string,
    fromISO: string,
    toISO: string,
  ): Promise<Array<{ id: string; name: string; value: string }>>;
  /** The rows of `kind` whose `field` holds a value that names no day (see
   *  field-day.ts). queryDateField leaves them out and hides nothing else;
   *  a reader that found nothing due asks here so it can SAY which record
   *  needs a person, rather than go quiet (#3279). */
  unreadableDateField(orgId: string, kind: string, field: string): Promise<Array<{ id: string; name: string; value: string }>>;
  /** A module that keeps a deadline of its own (a task's due date is a column,
   *  not a field) says how to read what has come due, so the overdue sweep sees
   *  it without naming the module. Rows left out: anything done or retired. */
  registerOverdueSource(source: OverdueSource): void;
  /** Every record whose deadline is `today` (a YYYY-MM-DD day) or earlier, from
   *  the registered sources and from any date field declared with the `due`
   *  role, not yet done. A source that cannot be read throws: "could not ask"
   *  is not "nothing is late". */
  overdue(orgId: string, today: string): Promise<OverdueRow[]>;
}
