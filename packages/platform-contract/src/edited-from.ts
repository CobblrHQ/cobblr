// A save never silently reverses another (#7925).
//
// An edit form holds the record as it was when it opened. Sent back whole on
// Save, its old copy overwrote whatever was saved since: a rename from an
// older tab put a moved shelf back (#7906), a note put a shopper's quantity
// back (#7889), a body edit put a title back (#7980), a description put a
// price back (#8118). Every save said saved.
//
// So a form sends only the fields it changed, and with them, in one header,
// the values those fields had when it opened. The server compares them with
// the record as it is now: a field someone changed since, to something other
// than what this save writes, refuses the save and says who changed what and
// when. A field nobody touched since goes through, so two people changing
// different fields of one record both keep theirs.

/** How long ago a change was, as a refusal says it: "a moment ago",
 *  "3 minutes ago", "an hour ago". */
export function agoWords(at: Date, now = Date.now()): string {
  const minutes = Math.round((now - at.getTime()) / 60_000);
  if (minutes < 1) return "a moment ago";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

/** The header that carries the values a save's fields had when its form opened. */
export const EDITED_FROM_HEADER = "x-cobblr-edited-from";

export type EditedFrom = Record<string, unknown>;

/** Header-safe (ASCII) form of the opened values. */
export function encodeEditedFrom(values: EditedFrom): string {
  return encodeURIComponent(JSON.stringify(values));
}

/** The opened values a header carries, or null for none or a malformed one. */
export function decodeEditedFrom(header: string | null | undefined): EditedFrom | null {
  if (!header) return null;
  try {
    const v = JSON.parse(decodeURIComponent(header)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as EditedFrom) : null;
  } catch {
    return null;
  }
}

const bag = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? (v as Record<string, unknown>) : {});

/** One value as stored and as sent compare equal: absent and null are the
 *  same, a number and its numeric text (pg answers a numeric column as text)
 *  are the same, a date and its ISO text are the same, and an object's key
 *  order does not count. */
export function sameStored(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null || v === "") return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** The fields this save would overwrite that changed since its form opened:
 *  each named field (or `metadata.<key>`, for the record's bag of extra fields)
 *  whose value now is neither what the form opened with nor what the save
 *  writes. A field the record does not carry under that name is not judged. */
export function staleFields(current: Record<string, unknown>, opened: EditedFrom, next: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [field, was] of Object.entries(opened)) {
    if (field === "metadata") {
      const now = bag(current.metadata);
      const sent = bag(next.metadata);
      for (const [key, wasKey] of Object.entries(bag(was))) {
        if (!(key in sent)) continue;
        if (!sameStored(now[key], wasKey) && !sameStored(now[key], sent[key])) out.push(`metadata.${key}`);
      }
      continue;
    }
    if (!(field in current) || !(field in next)) continue;
    if (!sameStored(current[field], was) && !sameStored(current[field], next[field])) out.push(field);
  }
  return out;
}
