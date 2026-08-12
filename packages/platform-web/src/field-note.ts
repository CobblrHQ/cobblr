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

/**
 * May this field carry a clarifier?
 *
 * Only a `text` field with a choice list. The whole point is to keep a CURATED
 * list short while still recording the long tail, so a field with no list has
 * nothing to protect: put the detail in the value. Without this guard `_note`
 * sprouts on every field and becomes a second, undocumented value column.
 */
export function canCarryNote(def: {
  type?: string | null;
  choices?: string[] | null;
}): boolean {
  return (def.type ?? "text") === "text" && (def.choices?.length ?? 0) > 0;
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
