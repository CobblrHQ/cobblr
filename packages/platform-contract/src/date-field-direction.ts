// Does this date point forwards or backwards?
//
// Every `date` custom field becomes a calendar event, which is the right call:
// a bundle declares "Renew by" and it shows up with no wiring. But the calendar
// then treats every one of them as a DEADLINE, so a field recording when
// something happened turns red and says OVERDUE.
//
// A real dashboard, with five genuinely useful things on it:
//
//   OVERDUE 5
//   Roma Tomatoes    - Bought on   6 days ago
//   Cucumbers Long   - Bought on   6 days ago
//   Croissant        - Bought on   6 days ago
//   Cheese Pizza     - Bought on   6 days ago
//   Baby Carrots     - Bought on   6 days ago
//
// Nothing there is late. Somebody did their shopping. And because five rows of
// shopping filled the OVERDUE list, anything actually late was pushed out of
// sight - which is the expensive part. An alarm that cries wolf is worse than
// no alarm, because it costs you the alarms that matter.
//
// WHICH WAY THE ERROR SHOULD FALL. A missed nudge costs one nudge. A false
// OVERDUE costs the whole list its credibility. So anything we cannot read
// confidently is treated as a RECORD: it still appears on the calendar and in
// "up next" if it is in the future, but it can never go red.

/** What a date field means. */
export type DateFieldDirection =
  /** A deadline: something is expected BY then, so passing it is late. */
  | "due"
  /** A record: something happened THEN. Passing it is just the past. */
  | "record";

/**
 * Words that make a date a deadline.
 *
 * Deliberately about the shape of the phrase rather than the domain, so it
 * works for a bundle nobody has written yet. "by" and "until" are prepositions
 * of deadline; the rest are the handful of nouns and verbs English uses for a
 * date you are meant to beat.
 *
 * A trailing `*` means "this word or anything starting with it" (`expir*` for
 * expire/expires/expiry). Everything else must match a WHOLE word: without
 * that, "Nextel account" reads as a deadline because it starts with "next",
 * and "Byline" because it starts with "by". Both were caught by the tests
 * below, which is what they are for.
 */
const DUE_MARKERS = [
  "due",
  "expir*",
  "renew*",
  "deadline",
  "by",
  "until",
  "till",
  "before",
  "next",
  "schedul*",
  "service",
  "inspection",
  "mot",
  "warranty",
  "valid",
  "best before",
  "use by",
  "sell by",
  "return",
  "replace",
  "reorder",
  "target",
  "eta",
  "arriv*", // arrives / arriving / arrival
];

/**
 * Words that make a date a record, even when a deadline word is also present.
 *
 * Checked FIRST because "Warranty purchased on" contains both, and the thing
 * that happened wins: a purchase is not a deadline no matter what it was a
 * purchase of.
 */
const RECORD_MARKERS = [
  "bought",
  "purchas*", // purchased / purchase date
  "acquired",
  "received",
  "arrived",
  "delivered",
  "opened",
  "installed",
  "created",
  "added",
  "registered",
  "issued",
  "started",
  "began",
  "logged",
  "recorded",
  "last",
  "since",
  "manufactured",
  "built",
  "born",
  "first",
];

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Does the label contain this marker as a WHOLE word (or, with a trailing `*`,
 *  as a word prefix)? Anchoring only the start let "Nextel" match "next" and
 *  "Byline" match "by", which is the difference between a heuristic and a
 *  coin toss. */
function hasMarker(label: string, marker: string): boolean {
  if (marker.includes(" ")) return new RegExp(`(^| )${marker}( |$)`).test(label);
  if (marker.endsWith("*")) return new RegExp(`(^| )${marker.slice(0, -1)}`).test(label);
  return new RegExp(`(^| )${marker}( |$)`).test(label);
}

/**
 * Which way a date field points, from what it is called.
 *
 * An explicit declaration always wins; this is only for the fields nobody
 * declared, which is all of them until bundles start saying.
 */
export function dateFieldDirection(
  label: string,
  declared?: DateFieldDirection | null | undefined,
): DateFieldDirection {
  if (declared === "due" || declared === "record") return declared;
  const l = normalise(label);
  if (!l) return "record";
  // Records win ties: a thing that happened is not a deadline, whatever else
  // the label mentions.
  if (RECORD_MARKERS.some((m) => hasMarker(l, m))) return "record";
  if (DUE_MARKERS.some((m) => hasMarker(l, m))) return "due";
  return "record";
}

/** Can a past date on this field be shown as late? Only a deadline can. */
export function canBeOverdue(label: string, declared?: DateFieldDirection | null): boolean {
  return dateFieldDirection(label, declared) === "due";
}

/**
 * How to read the row out loud.
 *
 * "Roma Tomatoes - Bought on" is a sentence somebody stopped writing. The
 * label already says what the date means, so the row only needs the two of them
 * in the order a person would say them.
 */
export function dateEventTitle(entityName: string, fieldLabel: string): string {
  const label = fieldLabel.trim().replace(/[:\-\s]+$/, "");
  if (!label) return entityName;
  // A label ending in a preposition ("Bought on", "Due by") is the start of a
  // phrase whose object is the date, so it reads correctly with the date after
  // it - which is exactly where the row puts it.
  return `${entityName} · ${label}`;
}
