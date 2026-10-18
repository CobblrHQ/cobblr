// What an automation is told about a record is a read, and it is held to the
// read scopes of the person who made the automation.
//
// A field behind a read scope (an asset's serial behind assets:view-serials, a
// price behind view-costs) is withheld from every read by someone without the
// scope. An event's data (its before and after bags carry every column of the
// record) goes to automations, and a member who may build one but lacks a
// scope could send the field out through a webhook or a chat step. So the
// event an automation receives has the fields its AUTHOR may not read taken
// out, wherever they sit. An automation with no author (made by a bundle, or
// before authors were recorded) reads as no one with a scope: fail closed, the
// same as its template fields, which are read with no viewer.

import type { EffectiveCapabilities } from "../auth/effective-capabilities.js";

/** The scoped fields of a kind this reader does not hold the scope for. */
export function fieldsHiddenFrom(scopes: Record<string, string> | null, caps: EffectiveCapabilities | null): string[] {
  if (!scopes || caps?.all) return [];
  return Object.entries(scopes)
    .filter(([, scope]) => !caps?.caps.has(scope))
    .map(([field]) => field);
}

const MAX_DEPTH = 6;

/** The value with these keys removed wherever they sit, in plain objects and
 *  arrays; the input is never changed. Returned as it came when nothing is
 *  hidden. */
export function withoutFields<T>(value: T, hidden: readonly string[]): T {
  if (hidden.length === 0) return value;
  const drop = new Set(hidden);
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== "object" || depth > MAX_DEPTH) return v;
    if (seen.has(v as object)) return undefined;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(value, 0) as T;
}
