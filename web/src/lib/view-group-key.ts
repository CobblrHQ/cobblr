// The one rule for reading a value off a saved-view row, and for the group key
// built from it. Shared by the generic table and Kanban renderers and by every
// cell, caption and chart formatter in ViewsPage, so the two readings cannot
// drift.
//
// A ROW'S CUSTOM FIELDS ARE NESTED. The server sends a view row as
// `{ title, subtitle, fields }`, where `fields` carries the module's own
// columns (name, qty, unit, manufacturer, location_id, location_name, …) and
// every bundle-added field under `fields.metadata`. So reading `fields[key]`
// alone finds a native column and misses every custom one: grouping Yarn's
// "By weight" view by `weight_class` put all three yarns under "(none)" while
// that view's own columns rendered their values (#3391, a regression from the
// location fix in #3360, which replaced this reading with a plain lookup).
// `fieldVal` is the reading, and the renderers use it for cells too.
//
// `location` is the reserved group key (LOCATION_GROUP_KEY): it means "the
// room the row's location rolls up to", the way the parts list groups, not a
// field literally named location. Rows carry `fields.location_id` and
// `fields.location_name`, never `location`, so without this rule a "By room"
// view put every row under "(none)" while the parts list beside it grouped by
// room (Home Inventory's headline view, #3341).
//
// Anything else is the row's own key, then the field (native or custom), then
// the subtitle; a blank buckets under "(none)".
import { LOCATION_GROUP_KEY } from "@cobblr/platform-web";

export interface GroupableRow {
  subtitle?: string;
  fields?: Record<string, unknown>;
}

export const NO_GROUP = "(none)";
/** What a person reads for the NO_GROUP bucket: the rows with no value. */
export const NO_GROUP_LABEL = "No value";

/** A row's value for `key`: the field itself, then the same name under
 *  `fields.metadata`, where every bundle-added field lives.
 *
 *  A field that stores an id (a person, a member, a linked record) arrives
 *  with its name beside it as `<key>_label`, and the name is what a cell shows
 *  and what a group is called: grouping by Owner must make an "Alex" column,
 *  not a column headed with Alex's id (#3787). */
export function fieldVal(fields: Record<string, unknown> | undefined, key: string): unknown {
  if (!fields) return undefined;
  const label = fields[`${key}_label`];
  if (typeof label === "string" && label.length > 0) return label;
  const top = fields[key];
  if (top !== undefined && top !== null) return top;
  const meta = fields.metadata;
  if (meta && typeof meta === "object") return (meta as Record<string, unknown>)[key];
  return undefined;
}

export function groupKeyOf(
  r: GroupableRow,
  groupBy: string,
  areaOf: (locationId: string | null | undefined) => string | null,
): string {
  if (groupBy === LOCATION_GROUP_KEY) {
    const id = fieldVal(r.fields, "location_id");
    const name = fieldVal(r.fields, "location_name");
    const room = areaOf(typeof id === "string" ? id : null) ?? (typeof name === "string" && name.length > 0 ? name : null);
    return room ?? NO_GROUP;
  }
  const raw =
    (r as unknown as Record<string, unknown>)[groupBy] ??
    fieldVal(r.fields, groupBy) ??
    (groupBy === "subtitle" ? r.subtitle : undefined);
  return typeof raw === "string" && raw.length > 0 ? raw : NO_GROUP;
}

/** Every grouped surface's buckets, in first-seen order: the full view's Table
 *  and Kanban renderers AND the dashboard's preview of that view. One function,
 *  so a preview cannot group differently from the view it previews (#3588: the
 *  dashboard read `fields[group_by]` itself, which knows neither the reserved
 *  `location` key nor `fields.metadata`, and called a lamp in Review Kitchen
 *  "no location set yet" beside a full By room view that had it). */
export function groupRows<R extends GroupableRow>(
  rows: R[],
  groupBy: string,
  areaOf: (locationId: string | null | undefined) => string | null,
): Map<string, R[]> {
  const byKey = new Map<string, R[]>();
  for (const r of rows) {
    const key = groupKeyOf(r, groupBy, areaOf);
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }
  return byKey;
}

/** A grouped view's columns, in the order a person reads them. Grouped by a
 *  field that declares its values (a kind's native `choices`, a custom
 *  dropdown's), the declared order leads and EVERY declared value is a column,
 *  empty ones included: "Rebuilding" with nothing in it says no machine is
 *  being rebuilt, where a missing column says nothing at all. Values nobody
 *  declared follow, alphabetically, and "(none)" is last. A stored value
 *  matches its choice whatever its case ("Functional" is `functional`'s
 *  column). With nothing declared, it is the values present, alphabetically.
 *  Before this the board sorted what it found with localeCompare, so a fleet's
 *  states read built, functional, kit, loaned (#3864). */
export function orderedGroups<R>(buckets: Map<string, R[]>, declared?: readonly string[] | null): Array<[string, R[]]> {
  const out: Array<[string, R[]]> = [];
  const choiceOf = new Map<string, string>();
  for (const c of declared ?? []) if (!choiceOf.has(c.toLowerCase())) choiceOf.set(c.toLowerCase(), c);
  const inChoice = new Map<string, R[]>([...choiceOf.values()].map((c) => [c, []]));
  const rest: Array<[string, R[]]> = [];
  let none: R[] | null = null;
  for (const [key, rows] of buckets) {
    if (key === NO_GROUP) none = rows;
    else if (choiceOf.has(key.toLowerCase())) inChoice.get(choiceOf.get(key.toLowerCase())!)!.push(...rows);
    else rest.push([key, rows]);
  }
  out.push(...inChoice.entries());
  out.push(...rest.sort(([a], [b]) => a.localeCompare(b)));
  if (none) out.push([NO_GROUP, none]);
  return out;
}

