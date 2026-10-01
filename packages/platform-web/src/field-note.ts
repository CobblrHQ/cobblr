// A choice field's durable VALUE, and the one-off clarifier beside it.
//
// A purchase yields two facts with very different lifespans. "eBay" is durable,
// reusable, and worth grouping by. "detroitaxle" is a specific seller you may
// never deal with again. Every naive handling of that pair is bad:
//
//   value = "eBay (detroitaxle)"   fragments one choice into many, so grouping,
//                                  filtering and "what have I bought from eBay"
//                                  all quietly stop working
//   drop the seller                throws away real provenance for want of
//                                  anywhere to put it
//   choices += "detroitaxle"       four hundred entries later the picker is
//                                  useless
//
// So the field stores ONLY the durable value, and the clarifier rides in a
// sibling key:
//
//   metadata.acquired_from        = "eBay"          groups, filters, counts
//   metadata.acquired_from_note   = "detroitaxle"   displays, searches
//
// Rendered as one thing ("eBay · detroitaxle"), read as two.
//
// THE RULE THAT MAKES THIS SAFE: identity is the value alone. Grouping, saved
// view filters, counts and matching never look at the note. Search does,
// because "where did I get that detroitaxle part" is a question people ask.
// The note is presentation and recall, never a key.
//
// See docs/design-decisions/arrivals.md.

// The key convention itself lives in the CONTRACT: the receipt mapper writes
// these keys server-side and this panel reads them client-side, so a second copy
// of "_note" would drift the first time either was touched. Re-exported here so
// existing web consumers import from one obvious place.
export {
  FIELD_NOTE_SUFFIX as NOTE_SUFFIX,
  fieldNoteKey as noteKey,
  isFieldNoteKey as isNoteKey,
} from "@cobblr/platform-contract";
import { fieldNoteKey as noteKey } from "@cobblr/platform-contract";
import { isAcquiredFromField } from "@cobblr/platform-contract/acquisition-source";

/**
 * May this field carry a clarifier?
 *
 * Only where a clarifier means something: the field that says where a thing
 * came from (the `acquired-from` role, or that field by its usual names when
 * the table declares no role), with a choice list to keep short. "eBay ·
 * detroitaxle" is a seller beside a channel; a "which one, specifically?" box
 * under Fuel = Gas read as a mistake, and it sat under every choice field in
 * the app (#4518). Without this guard `_note` sprouts on every field and
 * becomes a second, undocumented value column. A note already stored on any
 * other field is still shown, never dropped.
 */
export function canCarryNote(def: {
  name: string;
  type?: string | null;
  choices?: string[] | null;
  field_role?: string | null;
}): boolean {
  return (def.type ?? "text") === "text" && (def.choices?.length ?? 0) > 0 && isAcquiredFromField(def);
}

/** Is the clarifier OFFERED (the picker's right-hand column)? Only where it
 *  means something: a field that says where a thing came from (the seller
 *  beside "eBay"), or a record that already holds one, so existing detail is
 *  never hidden. A Fuel field of Gas gets no "which one?" box. */
export function offersClarifier(
  def: { name: string; type?: string | null; choices?: string[] | null; field_role?: string | null },
  note: string | null | undefined,
): boolean {
  if (canCarryNote(def)) return true;
  return (def.type ?? "text") === "text" && (def.choices?.length ?? 0) > 0 && !!note?.trim();
}

/** Read `name`'s clarifier out of a values bag. Blank reads as absent. */
export function noteOf(
  values: Record<string, unknown> | null | undefined,
  name: string,
): string | null {
  const raw = values?.[noteKey(name)];
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/**
 * One line for a value and its clarifier, for surfaces that render to plain
 * text rather than JSX (an export, a label, a template, a search blob).
 *
 * The separator is a middle dot rather than a bracket or a dash: it reads as
 * "and also", where "eBay (detroitaxle)" reads as a single compound name, which
 * is exactly the misreading this whole design exists to prevent.
 */
export function valueWithNote(value: unknown, note: string | null): string {
  const v = value == null ? "" : String(value).trim();
  if (!note) return v;
  if (!v) return note;
  return `${v} · ${note}`;
}
