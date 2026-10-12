// What a product is, learned from the people who filed it (#3769). A filed
// barcode item tells the barcode network which shared table it went into (a
// bundle's id, the same in every workspace) and its product fields (a yarn's
// fibre, a filament's material). The next workspace that holds the same table
// is answered from that with no AI: the table, and the fields filled.
//
// What may leave a workspace is decided here, once (the owner's decision of
// 2026-10-11): fields about the product only. Never a lot, the year a unit was
// made, a serial, a price, a seller, a place, a note or free text, never a
// person, a date or a link, and never anything that looks like a phone number,
// an email address or an account number.

import { factScopeOf, type ScopedFieldDef } from "@cobblr/platform-contract/fact-scope";

/** The network keys (barcode-intelligence `attributes.<key>`). */
export const LEARNED_BUNDLE_KEY = "cobblr_bundle";
const FIELD_PREFIX = "f_";

/** A field as the network reads it: whether it is a model fact is decided
 *  once, in fact-scope.ts. */
export type ShareableFieldDef = ScopedFieldDef;

/** The network key for a field, or null when its name cannot be one. */
export function learnedFieldKey(name: string): string | null {
  const k = name.toLowerCase();
  return /^[a-z0-9_]{1,60}$/.test(k) ? `${FIELD_PREFIX}${k}` : null;
}

function shareableValue(v: unknown): string | number | boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 60) return null;
  // A link, an address, a phone or account number is never a product fact.
  if (/[@]|https?:|www\.|\d[\d\s().-]{6,}\d/i.test(s)) return null;
  return s;
}

/** The product fields of a filed record that may go to the network, keyed for
 *  it. Pure. */
export function shareableProductFields(defs: readonly ShareableFieldDef[], values: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const d of defs) {
    if (factScopeOf(d) !== "model") continue;
    const key = learnedFieldKey(d.name);
    const v = shareableValue(values[d.name]);
    if (key && v !== null) out[key] = v;
  }
  return out;
}

/** The learned keys of a network answer's `attributes` (the table and the
 *  product fields), or null when it carries none. A provider's own attribute
 *  list is left where it is. */
export function learnedAttributesOf(attributes: unknown): Record<string, unknown> | null {
  if (!attributes || typeof attributes !== "object") return null;
  const out = Object.fromEntries(Object.entries(attributes as Record<string, unknown>).filter(([k]) => k === LEARNED_BUNDLE_KEY || k.startsWith(FIELD_PREFIX)));
  return Object.keys(out).length ? out : null;
}

export interface LearnedMenuEntry {
  bundle_external_id?: string;
  from_bundles?: readonly string[];
  fields: ReadonlyArray<{ name: string; type: string; choices?: string[] }>;
}

/** Which of `menu` the network's answer names, and the fields it fills: the
 *  table a bundle made (a live one first, then one the bundle would install),
 *  and only fields that table has, a choice field only with one of its own
 *  choices. Null when the answer names no table, or none here holds it. Pure. */
export function learnedRouteFor<E extends LearnedMenuEntry>(attributes: unknown, menu: readonly E[]): { entry: E; fields: Record<string, string | number | boolean> } | null {
  if (!attributes || typeof attributes !== "object") return null;
  const a = attributes as Record<string, unknown>;
  const bundle = typeof a[LEARNED_BUNDLE_KEY] === "string" ? (a[LEARNED_BUNDLE_KEY] as string) : null;
  if (!bundle) return null;
  const entry = menu.find((e) => e.from_bundles?.includes(bundle)) ?? menu.find((e) => e.bundle_external_id === bundle);
  if (!entry) return null;
  const fields: Record<string, string | number | boolean> = {};
  for (const f of entry.fields) {
    const key = learnedFieldKey(f.name);
    if (!key || !(key in a)) continue;
    const v = shareableValue(a[key]);
    if (v === null) continue;
    if (f.choices?.length && typeof v === "string" && !f.choices.some((c) => c.toLowerCase() === v.toLowerCase())) continue;
    // The network keeps every value as text: a number or a yes/no field takes
    // its own type back.
    if (f.type === "number" && typeof v === "string") {
      if (Number.isFinite(Number(v))) fields[f.name] = Number(v);
      continue;
    }
    if (f.type === "boolean" && typeof v === "string") {
      if (v === "true" || v === "false") fields[f.name] = v === "true";
      continue;
    }
    fields[f.name] = typeof v === "string" && f.choices?.length ? f.choices.find((c) => c.toLowerCase() === v.toLowerCase())! : v;
  }
  return { entry, fields };
}
