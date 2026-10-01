// A custom field holds a value of its declared type.
//
// The workspace declares a field's type once (module_field_defs); the value
// arrives through many doors: a form, a script, an importer, an assistant, a
// bundle's seed. A form's number input hands over text, and a bag written as
// it arrived then holds "10" where a reader expects 10. Every reader that
// checks `typeof` silently gets nothing, and nothing says so: a grocery's
// "Good for (days)" typed on the new-item form was the string "10", the lot
// rule dated no lot, and the shopping row beside it, coercing, promised a
// date the record never got (2026-09-13).
//
// So a module's write casts the bag by the kind's own field defs before it
// stores it, through this one rule, and a reader can trust the type it was
// promised. Only the types with a single honest reading are cast; anything
// that does not parse is left exactly as it came, never dropped, so a
// person's entry is not lost to a stricter rule than the field deserved.
//
// A date is cast to the day field-day.ts reads from it, so a month-only
// best-before ("2028-02", as the box prints it) is stored as the last day of
// that month and every reader agrees on it. Stored as it came, one such
// value threw the kernel's date query for a whole workspace and every expiry
// reminder in it went quiet for twelve days (#3279).

import { fieldDay } from "@cobblr/platform-contract/field-day";
import { asMeasure } from "@cobblr/platform-contract/measure";
import { amountOf, parseMoney } from "@cobblr/platform-contract/money";

/** One field's declared shape, as `fieldsFor` reports it. */
export interface TypedField {
  name: string;
  type: string;
  /** A number's or a measure's declared unit: a bare "10" in a volts field is 10 V. */
  unit?: string | null;
}

/** The value cast to its field type where the reading is unambiguous. */
export function castFieldValue(type: string, value: unknown, unit?: string | null): unknown {
  if (value === null || value === undefined) return value;
  // A measured value stored as { value, unit, text }: "4k7" is 4700 Ω however
  // it was typed. Text that does not read as one is kept as typed.
  if (type === "measure") {
    if (value && typeof value === "object") return value;
    return asMeasure(value, unit ?? null) ?? value;
  }
  // Money keeps the amount ("$4,300" is 4300); text that is not an amount
  // is kept as typed, for a person to fix.
  if (type === "money") {
    if (typeof value === "number") return value;
    const c = parseMoney(value);
    return c === null ? value : amountOf(c);
  }
  if (type === "date") return fieldDay(value) ?? value;
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  return value;
}

/** A custom-field bag with each declared field cast to its type. Keys the
 *  kind does not declare pass through untouched. */
export function castFieldValues(
  defs: readonly TypedField[],
  bag: Record<string, unknown>,
): Record<string, unknown> {
  if (!defs.length) return bag;
  const byName = new Map(defs.map((d) => [d.name, d]));
  let changed = false;
  const out: Record<string, unknown> = { ...bag };
  for (const [k, v] of Object.entries(bag)) {
    const def = byName.get(k);
    if (!def) continue;
    const cast = castFieldValue(def.type, v, def.unit ?? null);
    if (cast !== v) {
      out[k] = cast;
      changed = true;
    }
  }
  return changed ? out : bag;
}
