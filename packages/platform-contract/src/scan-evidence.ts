// Evidence outranks confidence: the ONE rule behind what a row may say a
// field is (#3059 Engine 4: #3070, #3071).
//
// A book scanned by its ISBN showed author "Vladislav Krapivin" at 0.95
// confidence while its cover, on the same card, read "А. Волков" (item
// 110/139 of the owner's inbox, 2026-09-15). The 0.95 was the identification
// (this code is this title); the author was the matchmaker completing a
// "known entity" from its own knowledge, wrong, and nothing on the row kept
// the two apart: the field looked as confirmed as the ISBN beside it, and
// the picture that contradicted it was never asked.
//
// The platform already keeps per-field provenance (acquisition-source.ts):
//   evidence   read off the thing or its record: the decoded code, what
//              the photo shows as printed, the receipt
//   inference  a model or a rule supplying it from what it could see, or
//              from what it knows
//   person     someone typed it
// This module is the enrichment side of that rule, read by the api when it
// stamps and by every surface when it renders:
//
//   1. Every field a route fills carries a standing. The api stamps them at
//      match time (field-provenance.ts): a value found in an evidence source
//      on the row is `evidence`, a value the model listed as completed from
//      knowledge is `inference/model`, anything else it filled is
//      `inference/router`. A surface reads the standing; it never guesses
//      from the confidence number.
//   2. A field the evidence contradicts is a conflict, and a conflict is a
//      doubt the row carries (scan-triage: needs-review, the sentence names
//      both values, the question offers both as taps) until a person
//      answers or says Looks fine. The identification's confidence has no
//      say in it: a 0.95 on the code is not a 0.95 on a guessed author.
//   3. The evidence is field-addressable, not prose: the decode's fields,
//      and what the vision pass read AS PRINTED (`photo_read`: the creator,
//      the brand, the title), kept apart from what it inferred. A read of
//      another picture than the row's own is no evidence about this one.
//
// Names are compared as people, not strings: "А. Волков", "Александр
// Волков" and "Alexander Volkov" are one author (a surname shared across
// scripts), "Vladislav Krapivin" is not.

import { FIELD_PROVENANCE_KEY, type FieldProvenance, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { EVIDENCE_CONFLICT_SENTENCE, fillSentence } from "@cobblr/platform-contract/scan-copy";
import { humanFieldLabel } from "@cobblr/platform-contract/display-identity";

export type { FieldProvenance, FieldProvenanceBy, FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";

/** The decoded bag a code carries (an ISBN's author and title, a VIN's make
 *  and year): `{ decoder_id, fields }`. */
export const DECODED_KEY = "decoded";

/** What the vision pass read AS PRINTED on the item, kept apart from what it
 *  inferred: `{ for: <image file id>, creator?, brand?, title? }`. Only ever
 *  about the picture named in `for`. */
export const PHOTO_READ_KEY = "photo_read";

export interface PhotoRead {
  for?: string | null;
  /** The author, artist or maker as printed on the cover or label. */
  creator?: string | null;
  brand?: string | null;
  title?: string | null;
}

/** The columns and keys this rule reads. Structural: an api row and a served
 *  row both satisfy it. */
export interface ScanEvidenceRow {
  status?: string | null;
  barcode_text?: string | null;
  image_file_id?: string | null;
  suggested_name?: string | null;
  suggested_candidates?: unknown;
  suggested_metadata?: unknown;
}

export type EvidenceSource = "decode" | "photo" | "receipt";

/** One thing the evidence says about one field. */
export interface EvidenceFact {
  field: string;
  value: string;
  source: EvidenceSource;
  /** How a sentence names the source: "the cover", "the ISBN record". */
  label: string;
}

export interface EvidenceConflict {
  field: string;
  /** What the row says. */
  claimed: string;
  /** What the evidence says. */
  evidence: string;
  source: EvidenceSource;
  label: string;
}

/** The fields a printed creator answers, and the ones a printed brand does. */
export const CREATOR_FIELD_NAMES = /^(author|authors|artist|creator|maker|director|composer|writer|illustrator|designer)$/i;
export const BRAND_FIELD_NAMES = /^(brand|manufacturer|make|maker)$/i;
export const TITLE_FIELD_NAMES = /^(title|name)$/i;

const metaOf = (row: ScanEvidenceRow): Record<string, unknown> => (row.suggested_metadata ?? {}) as Record<string, unknown>;

function candidateList(raw: unknown): Array<{ fields?: Record<string, unknown>; inferred?: unknown }> {
  if (Array.isArray(raw)) return raw as Array<{ fields?: Record<string, unknown>; inferred?: unknown }>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Array<{ fields?: Record<string, unknown> }>) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

export function fieldStandingsOf(meta: unknown): FieldProvenanceMap {
  const raw = ((meta ?? {}) as Record<string, unknown>)[FIELD_PROVENANCE_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as FieldProvenanceMap) : {};
}

export function photoReadOf(row: ScanEvidenceRow): PhotoRead | null {
  const raw = metaOf(row)[PHOTO_READ_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as PhotoRead;
  // The read is about ONE picture; a retake or a swap makes it stale.
  if (r.for && row.image_file_id && r.for !== row.image_file_id) return null;
  if (r.for && !row.image_file_id) return null;
  return r;
}

export function decodedFieldsOf(meta: unknown): { decoder: string | null; fields: Record<string, unknown> } {
  const raw = ((meta ?? {}) as Record<string, unknown>)[DECODED_KEY] as { decoder_id?: unknown; fields?: unknown } | undefined;
  const fields = raw && typeof raw === "object" && raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : {};
  return { decoder: typeof raw?.decoder_id === "string" ? raw.decoder_id : null, fields };
}

/** The record a decode came from, for the sentence: "the ISBN record", "the
 *  VIN decode". */
function decodeLabel(decoder: string | null): string {
  const d = (decoder ?? "").toLowerCase();
  if (d.includes("isbn")) return "the ISBN record";
  if (d.includes("vin")) return "the VIN decode";
  return "the code's record";
}

/** Where a printed read names its source: a titled work's cover, anything
 *  else's label. */
function photoLabel(field: string): string {
  return CREATOR_FIELD_NAMES.test(field) || TITLE_FIELD_NAMES.test(field) ? "the cover" : "the label";
}

/**
 * Everything the row's evidence says, field by field. The decode's fields
 * are facts about the fields of the same name; the photo's printed read
 * answers every field of the shape it read (a creator for author / artist /
 * maker, a brand for brand / manufacturer / make). Only fields the row's top
 * route actually has are addressed, so a fact never points at nothing.
 */
export function evidenceFactsOf(row: ScanEvidenceRow): EvidenceFact[] {
  const out: EvidenceFact[] = [];
  const top = candidateList(row.suggested_candidates)[0]?.fields ?? {};
  const names = Object.keys(top);
  const { decoder, fields } = decodedFieldsOf(row.suggested_metadata);
  for (const [name, v] of Object.entries(fields)) {
    const value = text(v);
    if (value) out.push({ field: name, value, source: "decode", label: decodeLabel(decoder) });
  }
  const read = photoReadOf(row);
  if (read) {
    const creator = text(read.creator);
    const brand = text(read.brand);
    for (const name of names) {
      if (creator && CREATOR_FIELD_NAMES.test(name)) out.push({ field: name, value: creator, source: "photo", label: photoLabel(name) });
      if (brand && BRAND_FIELD_NAMES.test(name)) out.push({ field: name, value: brand, source: "photo", label: photoLabel(name) });
    }
  }
  return out;
}

/** The fields the AI asserted rather than read: their standing is an
 *  inference, so a surface can keep them apart from the confirmed ones. */
export function scanAssertedFields(row: ScanEvidenceRow): Array<{ field: string; value: string; from: string }> {
  const top = candidateList(row.suggested_candidates)[0];
  const fields = top?.fields ?? {};
  const standings = fieldStandingsOf(row.suggested_metadata);
  const listed = new Set(Array.isArray(top?.inferred) ? (top!.inferred as unknown[]).filter((n): n is string => typeof n === "string") : []);
  const out: Array<{ field: string; value: string; from: string }> = [];
  for (const [field, v] of Object.entries(fields)) {
    const value = text(v);
    if (!value) continue;
    const s = standings[field];
    // A field something was READ for (a label, a receipt) is not "said by the
    // AI" however it was first guessed: both stand in its list of
    // contributions, and the headline names the decisive one (#4583).
    // Only a stamp that carries its list says so: a plain stamp reads as before.
    if (s?.contributions?.some((c) => c.source === "label" || c.source === "receipt" || c.source === "order" || c.source === "decode" || c.source === "person")) continue;
    if (s?.by === "inference") out.push({ field, value, from: s.from ?? "router" });
    else if (!s && listed.has(field)) out.push({ field, value, from: "model" });
    // An identifier nothing on the item carries is a suggestion, whoever
    // wrote it: a row filled before identifiers needed evidence still says so.
    else if (IDENTIFIER_FIELD_NAMES.test(field) && !identifierHasEvidence(row, field, value)) out.push({ field, value, from: s?.from ?? "search" });
  }
  return out;
}

// ── Names as people, not strings ─────────────────────────────────────────

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

/** A name's comparable tokens: lowercased, Cyrillic transliterated, marks
 *  and punctuation dropped, initials (one letter) left out. */
export function nameTokens(s: string | null | undefined): string[] {
  return nameParts(s).words;
}

/** Transliterated before the marks come off: decomposed, "ё" is "е" with
 *  a mark and "й" is "и" with one, and Dostoevsky would lose his ending. */
function latinOf(s: string | null | undefined): string {
  const latin = [...(s ?? "").toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join("");
  return latin.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** A name split into its words and its initials ("J. K. Rowling" is two
 *  initials and a word; "А. Волков" one of each). */
function nameParts(s: string | null | undefined): { words: string[]; initials: string[] } {
  const toks = latinOf(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  return { words: toks.filter((t) => t.length >= 2), initials: toks.filter((t) => t.length === 1) };
}

/** One spelling for the transliterations a name takes: Dostoevsky,
 *  Dostoevskiy and Dostoevskii are one word, as are Andrei and Andrey. */
function nameStem(w: string): string {
  return w.replace(/(iy|ii|ij|yi|y|i)$/, "").replace(/ks/g, "x").replace(/yo/g, "e").replace(/([a-z])\1/g, "$1");
}

const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && nameStem(a) === nameStem(b));

/**
 * Do two names name the same PERSON? They must share a word (the surname,
 * across scripts and spellings), and nothing else about them may differ:
 * a given name on both sides must be the same given name, an initial must
 * be the first letter of the other side's given name, and two initials must
 * match. "А. Волков" is Alexander Volkov; it is not Sergei Volkov, and
 * Andrei Volkov is not Alexander Volkov. Something one side does not say
 * ("Tolkien" against "J.R.R. Tolkien") is not a difference.
 *
 * The lean is deliberate: two people whose names converge must read as two.
 * A conflict raised in error costs the reviewer one tap on the right value;
 * a conflict suppressed in error confirms the model's guess under the
 * cover's contradiction with nothing on the row to say so.
 */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (!pa.words.length || !pb.words.length) return false;
  const sharedA = pa.words.filter((x) => pb.words.some((y) => sameWord(x, y)));
  const sharedB = pb.words.filter((y) => pa.words.some((x) => sameWord(x, y)));
  if (!sharedA.length) return false;
  const restA = pa.words.filter((w) => !sharedA.includes(w));
  const restB = pb.words.filter((w) => !sharedB.includes(w));
  if (restA.length && restB.length) return false;
  const initialsFit = (initials: string[], words: string[]): boolean => !initials.length || !words.length || initials.some((i) => words.some((w) => w.startsWith(i)));
  if (!initialsFit(pa.initials, restB) || !initialsFit(pb.initials, restA)) return false;
  if (pa.initials.length && pb.initials.length && !restA.length && !restB.length && !pa.initials.some((i) => pb.initials.includes(i))) return false;
  return true;
}

/** Do two names name the same MAKER? A brand leads with its distinctive
 *  word and whatever qualifies it follows: "Bosch Professional" is Bosch,
 *  "SC Johnson" is not Johnson & Johnson. Two brands agree when they lead
 *  with the same word and the shorter says nothing the longer does not. */
export function brandsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const lead = (s: string | null | undefined) => nameTokens(s).filter((w) => !/^(the|an?|co|inc|ltd|llc|gmbh)$/.test(w));
  const wa = lead(a);
  const wb = lead(b);
  if (!wa.length || !wb.length || wa[0] !== wb[0]) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

/** Values compared as the field's kind demands: a name by its tokens, a
 *  code by its digits and letters, anything else case-blind. */
function valuesAgree(field: string, claimed: string, evidence: string): boolean {
  if (CREATOR_FIELD_NAMES.test(field)) return namesAgree(claimed, evidence);
  if (BRAND_FIELD_NAMES.test(field)) return brandsAgree(claimed, evidence);
  const key = (v: string) => v.toLowerCase().replace(/[\s.\-_/]+/g, "");
  return key(claimed) === key(evidence);
}

/**
 * The fields the evidence contradicts. A person's answer is never argued
 * with, and a value the evidence itself supplied is never in conflict with
 * it; what is left is a value the row asserts (by inference, or with no
 * standing at all, as rows stamped before this carry) against a fact from
 * the decode or the photo that names the same field differently.
 */
export function scanEvidenceConflicts(row: ScanEvidenceRow): EvidenceConflict[] {
  const top = candidateList(row.suggested_candidates)[0]?.fields ?? {};
  const meta = metaOf(row);
  const typed = ((meta.user_fields as { values?: Record<string, unknown> } | undefined)?.values ?? {}) as Record<string, unknown>;
  const standings = fieldStandingsOf(meta);
  const out: EvidenceConflict[] = [];
  const seen = new Set<string>();
  for (const fact of evidenceFactsOf(row)) {
    if (seen.has(fact.field)) continue;
    if (text(typed[fact.field])) continue;
    const standing: FieldProvenance | undefined = standings[fact.field];
    if (standing?.by === "person") continue;
    if (standing?.by === "evidence") continue;
    const claimed = text(top[fact.field]);
    if (!claimed) continue;
    if (valuesAgree(fact.field, claimed, fact.value)) continue;
    seen.add(fact.field);
    out.push({ field: fact.field, claimed, evidence: fact.value, source: fact.source, label: fact.label });
  }
  return out;
}

/** The card sentence for a conflict: the source, both values, what to check. */
export function evidenceConflictWords(c: EvidenceConflict, fieldLabel?: string | null): string {
  const source = c.label.charAt(0).toUpperCase() + c.label.slice(1);
  const field = (fieldLabel ?? humanFieldLabel(c.field)).toLowerCase();
  return fillSentence(EVIDENCE_CONFLICT_SENTENCE, { source, evidence: c.evidence, claimed: c.claimed, field });
}

// ── Identifiers are facts only with evidence on the item (#3613) ─────────
//
// A blank white notebook, photographed, was filed with ISBN 9798502338400 at
// 0.95 and a ready Add. Nothing on the item said so: an Open Library search
// for its descriptive name ("Blank softcover book") answered with another
// book's listing ("Blank Recipe Book Softcover"), and that ISBN landed as
// fact. An identifier names ONE thing; a value found by searching for a
// description names whatever the search found first. So an identifier field
// is only a fact when the row itself carries it: the code that was scanned,
// a decoded field, text the photo shows, or a value stamped as evidence (a
// catalog match the item's own read corroborated) or typed by a person.
// Anything else stays a suggestion and is never filed.

/** Field names that identify one specific thing. A kind may also declare its
 *  own through fieldRole "identifier" (identifierFieldNames). */
export const IDENTIFIER_FIELD_NAMES = /^(isbn(_?1[03])?|upc|ean(_?13)?|gtin(_?1[234])?|barcode|serial(_?number)?|model_?(number|no)|mpn|part_?(number|no)|sku|vin|hin|imei|asin)$/i;

const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Everything the row itself carries as text: the scanned code, the decode,
 *  what the photo shows (observations, the printed read). */
function itemTexts(row: ScanEvidenceRow): string[] {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    const t = text(v);
    if (t) out.push(alnum(t));
  };
  push(row.barcode_text);
  for (const v of Object.values(decodedFieldsOf(meta).fields)) push(v);
  push(meta.photo_observations);
  const read = photoReadOf(row);
  if (read) for (const v of Object.values(read)) if (typeof v === "string") push(v);
  return out.filter((t) => t.length > 0);
}

/** The `from` a catalog answer carries when the catalog's title is the title
 *  read off the item (book-lookup.ts catalogTitleCorroborated): the one way a
 *  catalog reached WITHOUT the item's code vouches for an identifier. */
export const CATALOG_TITLE_MATCHED = "catalog, title matched";

/** Whether a stamp vouches for an identifier. A plain catalog stamp does only
 *  when the catalog was reached from the item's own code: a draft identified
 *  before #3613 carries `evidence/catalog` on an ISBN that was merely in the
 *  payload of a search by the item's description (another book's listing),
 *  and that is no evidence this is the book (#3647). */
export function stampVouchesForIdentifier(row: ScanEvidenceRow, s: FieldProvenance | undefined): boolean {
  if (!s) return false;
  if (s.by === "person") return true;
  if (s.by !== "evidence") return false;
  if (s.from === "catalog") return !!text(row.barcode_text);
  return true;
}

/** Whether an identifier's value has evidence on the item. A value of four
 *  characters or fewer is too short to find by containment and needs a stamp. */
export function identifierHasEvidence(row: ScanEvidenceRow, field: string, value: unknown): boolean {
  const v = text(value);
  if (!v) return true;
  const s = fieldStandingsOf(row.suggested_metadata)[field];
  if (stampVouchesForIdentifier(row, s)) return true;
  const want = alnum(v);
  if (want.length <= 4) return false;
  return itemTexts(row).some((t) => t.includes(want));
}

/** The identifier fields in `fields` that are not facts about this item: the
 *  ones a filing must leave out. `declared` adds a kind's own identifier
 *  fields to the named ones. */
export function unevidencedIdentifiers(row: ScanEvidenceRow, fields: Record<string, unknown>, declared: readonly string[] = []): string[] {
  const named = new Set(declared);
  return Object.entries(fields)
    .filter(([k, v]) => (IDENTIFIER_FIELD_NAMES.test(k) || named.has(k)) && text(v) && !identifierHasEvidence(row, k, v))
    .map(([k]) => k);
}

/** What a scan may write into a record, from any door: the confirm that
 *  creates one, "same one, fill it in" onto one that exists, the preview
 *  that says what either will write. Every field but the identifiers the
 *  item gives no evidence for (#3647: the merge preview offered a blank
 *  book's searched ISBN to a clean record because only confirm asked). */
export function evidencedFill(row: ScanEvidenceRow, fields: Record<string, unknown>, declared: readonly string[] = []): { fill: Record<string, unknown>; held: string[] } {
  const held = unevidencedIdentifiers(row, fields, declared);
  if (!held.length) return { fill: fields, held };
  const drop = new Set(held);
  return { fill: Object.fromEntries(Object.entries(fields).filter(([k]) => !drop.has(k))), held };
}

/** The stamps that make a draft from before the rule read as it should: each
 *  identifier the item gives no evidence for, stamped unconfirmed
 *  (`inference`, from a catalog search) where its stamp says otherwise or
 *  says nothing. Empty when there is nothing to heal. Pure. */
export function unconfirmedIdentifierStamps(row: ScanEvidenceRow, declared: readonly string[] = []): FieldProvenanceMap {
  const top = candidateList(row.suggested_candidates)[0];
  const fields = top?.fields ?? {};
  const standings = fieldStandingsOf(row.suggested_metadata);
  const out: FieldProvenanceMap = {};
  for (const k of unevidencedIdentifiers(row, fields, declared)) {
    const s = standings[k];
    if (s?.by === "inference") continue;
    out[k] = { by: "inference", from: "catalog search", ...(s?.role ? { role: s.role } : {}) };
  }
  return out;
}
