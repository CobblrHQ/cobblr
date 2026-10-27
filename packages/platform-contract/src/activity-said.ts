// How a record's history says a change: the field's label and its values in
// words, never a column name, an id, an API path or a storage key (#4517).
//
// "updated purchase price cents → 430000" and "updated image path →
// /api/v1/orgs/…" were a column name and a raw value. A change is said as
// "Paid: (empty) → $4,300", a place by its name, a photo as a photo (the api
// resolves references and files, history-describe.ts); this file is the pure
// part: the label, and a plain value by its type.
import { quantityNumber } from "@cobblr/platform-contract/quantity-number";
import { humanFieldLabel } from "@cobblr/platform-contract/display-identity";
import { fieldDay } from "@cobblr/platform-contract/field-day";
import { asMeasure } from "@cobblr/platform-contract/measure";

/** Something a person must never read in history: an API path, a storage
 *  key, a bare id. The history test asserts no line contains one. */
export const NOT_FOR_PEOPLE = /\/api\/v\d+\/|\/raw\?variant=|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The field a reference column points at, by its name ("location_id" is a
 *  location), or null when it is not one. */
export function referenceStem(name: string): string | null {
  const m = /^(.+)_id$/.exec(name);
  return m ? m[1]! : null;
}

/** The words for a field: the workspace's relabel or the declared label
 *  first, then the record's photo and a reference's own name, then the name
 *  spelt out. Never the column as written. */
export function saidLabel(name: string, declared?: string | null): string {
  if (declared && declared.trim()) return declared.trim();
  if (name === "image_path") return "Photo";
  const stem = referenceStem(name);
  if (stem) return humanFieldLabel(stem);
  return humanFieldLabel(name.replace(/_cents$/, ""));
}

export interface SaidFieldType {
  /** The manifest or field-def type ("date", "boolean", "select", …). */
  type?: string | null;
  /** The choices of a select field: a stored value is said as its label. */
  choices?: Array<string | { value: string; label?: string }> | null;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A plain value in words, or null for nothing (said "(empty)"). References,
 *  photos and money are the api's to say (they need a lookup or the
 *  workspace's currency); a value that still looks like an id or a path is
 *  never returned as text. */
/** A stock reading (how much is left, in what), whatever else the object
 *  carries: its amount and the unit it is kept in, or null. */
export function stockReadingOf(value: unknown): { remaining: number; unit: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.remaining !== "number" || !Number.isFinite(o.remaining)) return null;
  const unit = typeof o.unit === "string" && o.unit.trim() ? o.unit.trim() : null;
  return { remaining: o.remaining, unit };
}

export function saidValue(value: unknown, field: SaidFieldType = {}): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => saidValue(v, { ...field, type: null })).filter((v): v is string => !!v);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "boolean" || field.type === "boolean") return value === true || value === "true" ? "Yes" : "No";
  const type = field.type ?? "";
  if (type === "date" || type === "datetime" || value instanceof Date) {
    const day = fieldDay(value instanceof Date ? value : String(value).slice(0, 10));
    if (day) return DAY.format(new Date(`${day}T00:00:00Z`));
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // A stock reading carries its record's id and name beside the amount;
    // said by the name, a change to stock read as a title replacing itself
    // (#6039). It is how much: its unit needs the workspace's words, which a
    // caller that has them adds (stockReadingOf, quantityWithUnit).
    const reading = stockReadingOf(o);
    if (reading) return quantityNumber(reading.remaining);
    const named = o.label ?? o.name ?? o.title;
    if (typeof named === "string" && named.trim()) return named.trim();
    // A measure ("12 mm"), in the words the field itself shows.
    const m = asMeasure(o);
    if (m) return m.text;
    return "(changed)";
  }
  // As written: a year is 2019, not "2,019" (money has its own formatter).
  if (typeof value === "number") return String(value);
  const text = String(value).trim();
  // A numeric column arrives as a string: "12.000000000" is said 12, "1.500000000" 1.5 (#8639).
  if (type === "number" && /^-?\d+(?:\.\d+)?$/.test(text)) return String(Number(text));
  const choice = field.choices?.find((c) => (typeof c === "string" ? c : c.value) === text);
  if (choice && typeof choice !== "string" && choice.label) return choice.label;
  // An id or a path that reached here unresolved is still never read out.
  if (NOT_FOR_PEOPLE.test(text)) return "(changed)";
  return text;
}
