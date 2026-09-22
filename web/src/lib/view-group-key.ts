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

/** A row's value for `key`: the field itself, then the same name under
 *  `fields.metadata`, where every bundle-added field lives. */
export function fieldVal(fields: Record<string, unknown> | undefined, key: string): unknown {
  if (!fields) return undefined;
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
