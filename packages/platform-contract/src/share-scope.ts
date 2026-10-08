// Which records, and what of them: the one definition every way of showing
// part of a workspace to someone else reads (docs/design-decisions/share-scope.md).
//
// A share (another person's share space, #4627) and a public page (a link a
// stranger opens, #4502) both answer the same two questions, so they answer
// them with the same two values and never a copy of the rules:
//
//   ScopeDef       which records: whole collections, records whose field holds
//                  a value ("acquired from Vince"), hand-picked ones, and
//                  optionally what they contain.
//   VisibilityDef  what of each record: prices, private notes, places as real
//                  places, and restricted fields, each OFF until the owner
//                  turns it on.
//
// Pure: the field classes are decided from a field's definition (its type,
// role, unit, the private flag, whether it is gated), so the same record
// projects the same way on the server that copies it and on the page that
// shows it.

import { omitSecretValues } from "@cobblr/platform-contract/secret-field";
import { MONEY_ROLES, isCurrencyUnit } from "@cobblr/platform-contract/money";

export type ScopeRule =
  /** Every record of a kind ("3D Printers"). */
  | { type: "collection"; entity_kind: string }
  /** Records of a kind whose field holds this value (loaned to = Vince). */
  | { type: "field"; entity_kind: string; field: string; equals: string };

export interface ScopeRef {
  entity_kind: string;
  id: string;
}

export interface ScopeDef {
  rules: ScopeRule[];
  /** Hand-picked records, whatever the rules say. */
  picks: ScopeRef[];
  /** Records the rules select that are kept out anyway. */
  excluded: ScopeRef[];
  /** A container in scope brings what is in it (a toolbox and its tools). */
  with_contents: boolean;
  /** For a share with a person: everything lent to them is in it (any record
   *  whose "who has it" field, role `assignee`, names them), and leaves it
   *  when it comes back. On unless turned off; a public page has no person,
   *  so it selects nothing there. */
  lent_to_them: boolean;
}

export const EMPTY_SCOPE: ScopeDef = { rules: [], picks: [], excluded: [], with_contents: false, lent_to_them: true };

export interface VisibilityDef {
  /** Paid, cost, value: any money field. */
  prices: boolean;
  /** The notes, and every field the owner marked private. */
  private_notes: boolean;
  /** Where things are, as the real places (else the path as text). */
  places: boolean;
  /** Fields gated to a permission, allowed one by one, by name. */
  restricted: string[];
}

/** Nothing beyond the plain fields: the default for every share and link. */
export const VISIBILITY_NONE: VisibilityDef = { prices: false, private_notes: false, places: false, restricted: [] };

/** Read a stored scope, keeping only well-formed parts. */
export function readScope(v: unknown): ScopeDef {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ref = (r: unknown): ScopeRef | null => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return typeof x.entity_kind === "string" && typeof x.id === "string" ? { entity_kind: x.entity_kind, id: x.id } : null;
  };
  const rules: ScopeRule[] = [];
  for (const r of Array.isArray(o.rules) ? o.rules : []) {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    if (typeof x.entity_kind !== "string" || !x.entity_kind) continue;
    if (x.type === "collection") rules.push({ type: "collection", entity_kind: x.entity_kind });
    else if (x.type === "field" && typeof x.field === "string" && x.field && typeof x.equals === "string" && x.equals.trim()) {
      rules.push({ type: "field", entity_kind: x.entity_kind, field: x.field, equals: x.equals.trim() });
    }
  }
  return {
    rules,
    picks: (Array.isArray(o.picks) ? o.picks : []).map(ref).filter((r): r is ScopeRef => !!r),
    excluded: (Array.isArray(o.excluded) ? o.excluded : []).map(ref).filter((r): r is ScopeRef => !!r),
    with_contents: o.with_contents === true,
    lent_to_them: o.lent_to_them !== false,
  };
}

/** Read stored visibility; anything missing is off. */
export function readVisibility(v: unknown): VisibilityDef {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    prices: o.prices === true,
    private_notes: o.private_notes === true,
    places: o.places === true,
    restricted: Array.isArray(o.restricted) ? o.restricted.filter((x): x is string => typeof x === "string") : [],
  };
}

/** What a field is, for deciding who may see it. */
export type FieldClass = "price" | "private" | "place" | "restricted" | "secret" | "plain";

export interface ClassifiableField {
  name: string;
  type?: string | null;
  field_role?: string | null;
  unit?: string | null;
  /** A native money column (cents or an amount). */
  money?: "cents" | "amount" | null;
  /** The owner marked it private. */
  private?: boolean | null;
}

/** Native columns that are money or private whatever a kind calls them. */
const NATIVE_PRICE = /(^|_)(price|cost|paid|value)(_cents)?$/;
const NATIVE_PRIVATE = new Set(["notes"]);
/** Where a thing is, however a kind spells it: its location id, the name a
 *  resolver reads it out as (location_name), a path. */
const NATIVE_PLACE = /^(location|place)(_|$)|_location$/;

export function classifyField(f: ClassifiableField, gated: ReadonlySet<string>): FieldClass {
  if (f.type === "secret") return "secret";
  if (gated.has(f.name)) return "restricted";
  if (f.private === true || NATIVE_PRIVATE.has(f.name)) return "private";
  if (f.type === "money" || f.money || (f.field_role && MONEY_ROLES.has(f.field_role)) || (f.type === "number" && isCurrencyUnit(f.unit)) || NATIVE_PRICE.test(f.name)) return "price";
  if (NATIVE_PLACE.test(f.name) || f.field_role === "location" || f.type === "location") return "place";
  return "plain";
}

/** May a field of this class (and name) be shown under this visibility? */
export function fieldVisible(cls: FieldClass, name: string, vis: VisibilityDef): boolean {
  switch (cls) {
    case "secret":
      return false;
    case "plain":
      return true;
    case "price":
      return vis.prices;
    case "private":
      return vis.private_notes;
    case "place":
      return vis.places;
    case "restricted":
      return vis.restricted.includes(name);
  }
}

export interface ProjectedRecord {
  /** The record's own columns that may be shown. */
  fields: Record<string, unknown>;
  /** Its custom fields that may be shown. */
  metadata: Record<string, unknown>;
  /** Fields left out, by class: so a page can say "prices hidden". */
  hidden: Partial<Record<Exclude<FieldClass, "plain">, string[]>>;
}

/** A record as someone outside the workspace may see it under `vis`. A field
 *  with no definition is classified by its name alone (a stray metadata key
 *  named "cost" is still a price). Keys starting with "_" and clarifier notes
 *  of hidden fields go with them. */
export function projectRecord(
  record: { fields: Record<string, unknown> },
  defs: readonly ClassifiableField[],
  gated: ReadonlySet<string>,
  vis: VisibilityDef,
): ProjectedRecord {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const hidden: ProjectedRecord["hidden"] = {};
  const keep = (name: string): boolean => {
    const base = name.endsWith("_note") ? name.slice(0, -"_note".length) : name;
    const cls = classifyField(byName.get(base) ?? { name: base }, gated);
    if (fieldVisible(cls, base, vis)) return true;
    if (cls !== "plain" && base === name) (hidden[cls] ??= []).push(name);
    return false;
  };
  const fields: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  const safe = omitSecretValues(record.fields) as Record<string, unknown>;
  for (const [k, v] of Object.entries(safe)) {
    if (k === "metadata" || k.startsWith("_")) continue;
    if (keep(k)) fields[k] = v;
  }
  const meta = safe.metadata && typeof safe.metadata === "object" ? (safe.metadata as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith("_")) continue;
    if (keep(k)) metadata[k] = v;
  }
  return { fields, metadata, hidden };
}

export function listInviteScope(kind: string, ids: readonly string[] = []): ScopeDef {
  return {
    rules: ids.length ? [] : [{ type: "collection", entity_kind: kind }],
    picks: ids.map((id) => ({ entity_kind: kind, id })),
    excluded: [], with_contents: false, lent_to_them: false,
  };
}
