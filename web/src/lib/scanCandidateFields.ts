import { requirementImpliedBy, type StorageRequirement } from "@cobblr/platform-contract/storage-requirement";
import { isReceiptDateField, isReceiptFromField } from "@cobblr/platform-contract/receipt-fact-names";

// A match is a SNAPSHOT. The table can change under it.
//
// The matchmaker keeps only the fields the destination declared at the moment
// it ran ("keep only fields that exist on the table"). Nothing re-checks that
// afterwards, and a scan can sit in the inbox for weeks - across a bundle
// upgrade that retires a field, or a person deleting one.
//
// That is not hypothetical. A humidifier scanned on 2026-07-14 carried
// `room: "Living room"`; on 2026-07-15 the Home Inventory bundle retired its
// Room field into the platform's real Locations (#1090). Eleven days later the
// card still showed a `room` chip saying "Living room" beside the item's actual
// location, "Den" - two answers to "where is this thing", one of them from a
// table shape that no longer exists, and neither the label nor the value could
// be saved anywhere.
//
// So the destination's CURRENT fields decide what a card shows and what a
// confirm writes. Read time, not just write time.

/** The shape both callers share: a destination's declared fields. */
export interface DestinationFields {
  fields: Array<{ name: string }>;
}

/**
 * The candidate's fields, minus anything the destination no longer declares.
 *
 * `entry` null or undefined (the menu has not loaded, or the destination is not
 * in it) means WE CANNOT TELL - and hiding a real field is worse than briefly
 * showing a stale one, so the fields pass through untouched.
 */
export function fieldsStillOnTable<T>(
  entry: DestinationFields | null | undefined,
  fields: Record<string, T> | null | undefined,
): Record<string, T> {
  const src = fields ?? {};
  if (!entry) return { ...src };
  const declared = new Set(entry.fields.map((f) => f.name));
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(src)) if (declared.has(k)) out[k] = v;
  return out;
}

/** The keys that were dropped - what the scan read and the table can no longer
 *  hold. Kept separate so a caller can say so rather than vanish them. */
export function fieldsNoLongerOnTable(
  entry: DestinationFields | null | undefined,
  fields: Record<string, unknown> | null | undefined,
): string[] {
  if (!entry || !fields) return [];
  const declared = new Set(entry.fields.map((f) => f.name));
  return Object.keys(fields).filter((k) => !declared.has(k));
}

/**
 * A value that is the unremarkable state of its field, and so not worth a chip.
 *
 * "Must be kept: ambient" sat on every bakery line of a receipt (2026-09-06).
 * Ambient is what nearly everything is; the chip exists to catch the eye on
 * the exceptions - refrigerated, frozen - and a chip that says "nothing to
 * see" on eight of twelve lines costs the two that matter their contrast. The
 * value is still STORED (the storage check reads it, and ambient there is a
 * positive assertion), and the full-fields form still shows it; only the
 * closed card's glance drops it.
 *
 * Matched on the field NAME and the value, exactly, so a field somebody named
 * `ambient_light` or a note that contains the word is left alone.
 */
export function isQuietDefault(name: string, value: unknown): boolean {
  const n = name.trim().toLowerCase();
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return n === "storage_requirement" && v === "ambient";
}

/**
 * A value another chip on the same card already says.
 *
 * "Storage: Fridge" and "Must be kept: refrigerated" sat side by side on a
 * receipt's carrots (2026-09-07). Same fact, two spellings, and the pair reads
 * as two things to check. When the storage choice IMPLIES the requirement the
 * requirement chip is dropped; when they disagree (Counter beside
 * refrigerated) both stay, because that is the one case the pair is news. The
 * vocabulary is the platform's, shared with the server fill that produced the
 * agreement in the first place.
 */
export function isImpliedByPeer(name: string, value: unknown, fields: Record<string, unknown> | null | undefined): boolean {
  if (name.trim().toLowerCase() !== "storage_requirement" || !fields) return false;
  const req = typeof value === "string" ? (value.trim().toLowerCase() as StorageRequirement) : null;
  const storageKey = Object.keys(fields).find((k) => k.trim().toLowerCase() === "storage");
  return !!req && !!storageKey && requirementImpliedBy(req, fields[storageKey]);
}

/**
 * A value the receipt already states for every line.
 *
 * "Bought on 2026-09-06" sat on all twelve lines of one receipt (2026-09-07),
 * under a session header that already said "Receipt · Lidl · Sep 6", beside a
 * title that already said "from Lidl". The server writes the till's date and
 * shop into each line's provenance fields on purpose (they are facts, and they
 * ride to the record); the CHIP is what is redundant. Dropped from the glance
 * only when the value IS the receipt's; a line somebody re-dated by hand still
 * shows its date, because then it is news. Still under All fields either way.
 */
export function isStatedByReceipt(
  name: string,
  value: unknown,
  meta: { receipt_date?: unknown; receipt_vendor?: unknown } | null | undefined,
): boolean {
  if (!meta || typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (isReceiptDateField(name) && typeof meta.receipt_date === "string") return v === meta.receipt_date.trim().toLowerCase();
  if (isReceiptFromField(name) && typeof meta.receipt_vendor === "string") return v === meta.receipt_vendor.trim().toLowerCase();
  return false;
}
