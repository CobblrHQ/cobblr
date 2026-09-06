// A place is a Location. It is never a field value.
//
// The scan matched a humidifier and filled `room: "Living room"` on a table
// whose Room field the platform had already retired into real Locations. The
// card then showed two answers to "where is this" - the item's Location said
// Den, the chip said Living room - and only one of them was somewhere the
// record could keep (2026-09-03).
//
// Location is `core-locations`' job. A model filling a place into a text field
// duplicates a platform capability, which the repo's own rule forbids, and no
// prompt wording makes that reliably not happen. So it is stripped here, in
// code, on the one path every extraction takes.
//
// THE RULE IS VALUE-ANCHORED, DELIBERATELY. A blocklist of field names was
// tried against every shipped bundle first and it is wrong: Plants declares
// `zone` meaning "Irrigation zone", and CNC Tooling declares `bin` for a tool
// carousel. Neither is a place, and neither may be stripped. So a field is a
// place only when BOTH hold:
//
//   1. its NAME is one the platform would own (an exact match, so
//      `storage_requirement` and `shelf_life_days` are untouched), and
//   2. its VALUE names a Location that actually exists in this workspace.
//
// "Living room" in a workspace that has a Living Room is a place. "3" in an
// irrigation zone is not, and neither is `storage_requirement: "Fridge"` in a
// kitchen that happens to contain a Fridge - the name saves it. Both halves are
// required, so the rule errs toward keeping a field it cannot prove is a place.

/** Field names that mean "where the thing is", when the value agrees. Exact
 *  matches only - a substring rule would eat `shelf_life_days`. */
const PLACE_NAMES = new Set([
  "room",
  "rooms",
  "location",
  "locations",
  "place",
  "placement",
  "where",
  "stored_in",
  "storage_location",
  "kept_in",
  "whereabouts",
  // `storage` with a value like "Fridge" is a place. An older Groceries shipped
  // a `storage` field with choices Fridge / Freezer / Pantry / Counter, and an
  // update never removes a field, so workspaces still carry it and the scan
  // fills it - and then reported no location while the chip said Fridge
  // (2026-09-06, twelve lines of one receipt). The exact-name rule keeps
  // `storage_requirement` untouched: that one says HOW, not WHERE.
  "storage",
]);

const norm = (v: string): string => v.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** Is this field a place the platform already owns? */
export function isPlaceField(name: string, value: unknown, locationNames: Iterable<string>): boolean {
  if (!PLACE_NAMES.has(norm(name).replace(/ /g, "_")) && !PLACE_NAMES.has(norm(name))) return false;
  const v = typeof value === "string" ? norm(value) : "";
  if (!v) return false;
  for (const loc of locationNames) if (norm(loc) === v) return true;
  return false;
}

/**
 * The extraction, minus any field that is really a Location.
 *
 * `stripped` carries what came out, so the value is recorded rather than lost -
 * it is the answer to "where does this go", and a later step can offer it as
 * the item's location instead of pretending it was never read.
 */
export function stripPlaceFields<T>(
  fields: Record<string, T>,
  locationNames: Iterable<string>,
): { fields: Record<string, T>; stripped: Record<string, T> } {
  const names = [...locationNames];
  const kept: Record<string, T> = {};
  const stripped: Record<string, T> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isPlaceField(k, v, names)) stripped[k] = v;
    else kept[k] = v;
  }
  return { fields: kept, stripped };
}
