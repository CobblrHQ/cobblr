// A number a person types, read the way their own locale writes numbers (#4115).
//
// On a German phone "1,5" is one and a half and "1.500" is fifteen hundred; on
// an English one "1.5" is one and a half and "1,500" is fifteen hundred. A part's
// Minimum typed "1,5" on a German iPhone was stored as 15: the number field
// dropped the comma it did not understand. Reading by the locale settles the
// usual case; a text that also means something else in the other convention
// ("1.500" to an English reader, or "1,5" typed on an English phone) is said
// back before it is saved, never guessed at in silence.

export interface NumberMarks {
  decimal: string;
  group: string;
}

/** The decimal mark and the thousands mark this locale writes. */
export function numberMarks(locale?: string): NumberMarks {
  let parts: Intl.NumberFormatPart[] = [];
  try {
    parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  } catch {
    parts = new Intl.NumberFormat("en").formatToParts(12345.6);
  }
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const group = parts.find((p) => p.type === "group")?.value ?? (decimal === "," ? "." : ",");
  return { decimal, group };
}

export interface TypedNumber {
  /** What will be stored, or null while the text is not a number. */
  value: number | null;
  /** True when the text could be read another way: say `value` back before saving. */
  ambiguous: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function readWith(t: string, decimal: string, group: string): number | null {
  const d = esc(decimal);
  const g = group.trim() === "" ? "[\\s\\u00a0\\u202f]" : esc(group);
  const grouped = new RegExp(`^-?\\d{1,3}(?:${g}\\d{3})+(?:${d}\\d+)?$`);
  const plain = new RegExp(`^-?\\d+(?:${d}\\d+)?$|^-?${d}\\d+$`);
  if (!grouped.test(t) && !plain.test(t)) return null;
  const n = Number(t.replace(new RegExp(g, "g"), "").replace(decimal, "."));
  return Number.isFinite(n) ? n : null;
}

/** Reads `text` as `locale` writes numbers. */
export function readLocaleNumber(text: string, locale?: string): TypedNumber {
  const t = text.trim().replace(/[−–]/g, "-");
  if (!t) return { value: null, ambiguous: false };
  const own = numberMarks(locale);
  const other: NumberMarks = own.decimal === "," ? { decimal: ".", group: "," } : { decimal: ",", group: "." };
  const mine = readWith(t, own.decimal, own.group);
  const theirs = readWith(t, other.decimal, other.group);
  if (mine !== null) return { value: mine, ambiguous: theirs !== null && theirs !== mine };
  if (theirs !== null) return { value: theirs, ambiguous: true };
  return { value: null, ambiguous: false };
}

/** A number written for `locale` to type over: its own decimal mark and no
 *  thousands mark, so it reads back as the same number and is never ambiguous. */
export function writeLocaleNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return "";
  return String(n).replace(".", numberMarks(locale).decimal);
}
