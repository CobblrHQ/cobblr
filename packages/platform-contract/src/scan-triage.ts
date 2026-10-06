// What a pending capture still needs from a person — the ONE definition.
//
// The scan inbox shows three facets above the queue: how many are pending, how
// many have been waiting too long, and how many need a human to look. Those
// predicates were written inline in the Scan page, so they existed only in the
// browser. The API could not filter by them and the assistant could not read
// them, which is why "can you see the items in my scan inbox?" was answered with
// the page's own summary line and nothing else.
//
// Pure and shared: the page, the list route's `triage` filter, and the
// assistant's list tool all import from here, so a facet can never mean one
// thing on screen and another to whoever asks about it.
//
// "Ready to file" lives here for the same reason. The card's one-tap Add, the
// session's File and File N, the whole-session File preview, the dashboard's
// ready count and the assistant's put-away plan each used to decide for
// themselves what was ready, and none of them read the needs-review flag: a
// row the pipeline itself had flagged (a crop that could not be cut, twins
// that disagree, a low-trust lookup) still showed a green Add and was listed
// as "filed as new" while the header counted it under the warning (#2980).
// One predicate, read by every commit surface, keeps the warning and the
// commit in agreement by construction.

import { scanSourceConflict, sourceConflictWords, type SourceConflict } from "@cobblr/platform-contract/acquisition-source";
import { evidenceConflictWords, scanEvidenceConflicts } from "@cobblr/platform-contract/scan-evidence";
import { identifyNeverTried, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import {
  ACTION_ADD,
  ACTION_BLOCKED,
  actionInstallAdd,
  PHOTO_CHECK_NOTE,
  sessionAddLabel,
  sessionAddCaption,
  ACTION_MERGE,
  ACTION_REVIEW,
  AI_FAILED_SENTENCE,
  BLOCKED_SENTENCE,
  DUPLICATE_SENTENCE,
  AMBIGUOUS_MATCH_SENTENCE,
  WHICH_PLACE_SENTENCE,
  NEW_PLACE_SENTENCE,
  NEW_PLACE_BARE_SENTENCE,
  CHECK_FIELDS_SENTENCE,
  CHECK_FIELDS_WAITING_SENTENCE, CHECK_FIELDS_LIMIT_SENTENCE,
  PAPERWORK_SENTENCE,
  ACTION_ADD_PLACE,
  HELD_GUESS_BECAUSE,
  HELD_GUESS_PROMPT,
  LABEL_GUESS_BECAUSE,
  LABEL_GUESS_SOURCE,
  HELD_GUESS_SOURCE,
  INSTALL_SENTENCE,
  INSTALL_BLOCKED_SENTENCE,
  UNAVAILABLE_SENTENCE,
  KEYWORD_ROUTE_SENTENCE,
  LOW_CONFIDENCE_SENTENCE,
  MERGE_SENTENCE,
  NO_NAME_SENTENCE,
  RECEIPT_UNREAD_SENTENCE,
  SHORT_BARCODE_DOUBT,
  SPLIT_GROUP_DOUBT,
  SPLIT_SIBLINGS_DOUBT,
  THROTTLED_SENTENCE,
  UNTRUSTED_DOUBT,
  classifiedCodeOf,
  fillSentence,
} from "@cobblr/platform-contract/scan-copy";
import { createCapabilityForModule } from "@cobblr/platform-contract/create-capability";
import { isBareCodeName, nameIsRejected } from "@cobblr/platform-contract/display-identity";
import { normaliseTargetKind, type DestinationTable } from "@cobblr/platform-contract/destination-label";
import { rankFits, type FitItem, type FitTable } from "@cobblr/platform-contract/table-fit";
import { SCAN_TOOLS, type ScanTool, type ScanToolHints } from "@cobblr/platform-contract/scan-tools";

/** The columns/fields any triage decision is made from — the subset of a scan
 *  row these predicates read. Deliberately structural: the API row, the web
 *  row type and a test fixture all satisfy it without a shared row class. */
export interface ScanTriageRow {
  status?: string | null;
  suggested_name?: string | null;
  ai_confidence?: number | string | null;
  suggested_metadata?: unknown;
  created_at?: string | Date | null;
  target_location_id?: string | null;
  target_container_id?: string | null;
  /** The matchmaker's routes, top first. jsonb on the API row, a typed list on
   *  the web row, and a JSON string on a row read back before parsing, so it
   *  is read through `scanTopCandidate`. */
  suggested_candidates?: unknown;
  /** The pipeline's own sentence about the row. When the row is flagged this
   *  is the reason (the crop that failed, the fields the twins disagree on),
   *  and the reason is what a person is shown instead of Add. */
  ai_notes?: string | null;
  /** The maker the lookup named, for the fit rule (a brand says who). */
  suggested_manufacturer?: string | null;
  /** The code that was scanned, when one was: a short one is what a
   *  low_trust flag on a barcode row is about (scanDoubt). */
  barcode_text?: string | null;
  /** The row's own picture: what a photo read (`photo_read`) is evidence
   *  about only while it is about THIS picture (scan-evidence.ts). */
  image_file_id?: string | null;
  /** How the row came in ("receipt" for a line read off a document). */
  source_kind?: string | null;
  /** How many things the row stands for. */
  quantity?: number | null;
}

/**
 * Is this row the PAPERWORK for one thing, rather than a thing? A bill of
 * sale is one thing and its purchase: matched to a car the workspace already
 * has, it is that car's paperwork, never a second car (#4523, #4633). Unless
 * the paper itself says it sold several.
 */
export function isPaperworkRow(row: Pick<ScanTriageRow, "source_kind" | "quantity" | "suggested_metadata">): boolean {
  if (row.source_kind !== "receipt") return false;
  if ((row.quantity ?? 1) > 1) return false;
  return (metaOf(row as ScanTriageRow) as { receipt_document?: unknown }).receipt_document === "bill-of-sale";
}

/**
 * Does this row's match make it paperwork for the matched record? A line off
 * a document whose code found the record (a VIN), or a bill of sale matched by
 * ANY route: by name, "Is this the same one?", "It's this one". Every route
 * then goes through the one paperwork door: fills by meaning, no "+1 more".
 */
export function isPaperworkMatch(row: Pick<ScanTriageRow, "source_kind" | "quantity" | "suggested_metadata">, match: { matched_by?: string | null } | null | undefined): boolean {
  if (!match || row.source_kind !== "receipt") return false;
  return match.matched_by === "identifier" || isPaperworkRow(row);
}

/** The row columns the predicates above read. A server select that feeds
 *  a row to needsScanReview / matchesScanFacet / isScanReadyToFile spreads
 *  this, so a column a predicate starts reading (the route, for the source
 *  check) cannot be left out of one select and quietly read as "nothing
 *  flagged" there while the list flags it (`lint:scan-triage-columns`). */
export const SCAN_TRIAGE_COLUMNS = [
  "status",
  "suggested_name",
  "ai_confidence",
  "suggested_metadata",
  "suggested_candidates",
  "created_at",
  "target_location_id",
  "target_container_id",
  "ai_notes",
  "barcode_text",
  "image_file_id",
  "suggested_manufacturer",
] as const;

/** Confidence at or above which an identification stands on its own. Below it a
 *  human is asked, because a wrong name filed confidently is worse than a slow
 *  one. */
export const SCAN_REVIEW_CONFIDENCE = 0.5;

/** Waiting longer than this is "rotting" — the nudge to clear the queue. Two
 *  days is when a capture stops being fresh in the user's memory. */
export const SCAN_STALE_DAYS = 2;

const STALE_MS = SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;

interface TriageMeta {
  /** "store-code": a shop's own label, classified at insert; nothing to look
   *  up, so the reason is known before any lookup runs (#3017). */
  code_type?: string;
  low_trust?: boolean;
  rate_limited?: boolean;
  /** The identify pass was asked and did not answer (coded, #2916). */
  identify_failure?: unknown;
  /** A web-search name held back for want of a second source (#2918): the
   *  row stays nameless and the guess rides here, so the card can ASK. */
  held_name?: string;
  /** Text read off the label in the scan frame that made no confident name
   *  (#4933): offered as a one-tap guess. */
  label_text?: string;
  held_reason?: string;
  reviewed?: boolean;
  photo_wanted?: boolean;
  split_review?: string;
  split_disagreed?: string[];
  /** A fact the name states, kept when it overruled the model's read
   *  (core-scan's name-facts): the field, the value the name gives, the
   *  words that gave it, and what the model had put there. */
  name_facts?: Array<{ field: string; value: string; said: string; was: string | null }>;
  /** Values a person typed on the row before filing, by the table they
   *  were typed for (core-scan's user-fields). */
  user_fields?: { kind?: string | null; values?: Record<string, unknown> };
  /** A read of this photo as a receipt failed (core-scan's receipt-photo). */
  receipt_read_failed?: unknown;
  /** The shape check's verdict on the picture. */
  receipt_shape?: { verdict?: string } | null;
  /** A receipt read is running now. */
  reading_receipt?: boolean;
  /** The person answered "treat it as one item". */
  read_as_item?: boolean;
}

function metaOf(row: ScanTriageRow): TriageMeta {
  return (row.suggested_metadata ?? {}) as TriageMeta;
}

function isPending(row: ScanTriageRow): boolean {
  return row.status === "pending";
}

function isNamed(row: ScanTriageRow): boolean {
  // A name the person turned down is no name: it cannot file, and the row
  // waits for theirs (#3724).
  return !!row.suggested_name?.trim() && !nameIsRejected(row) && !isBareCodeName(row.suggested_name, row.barcode_text);
}

/**
 * A receipt whose lines could not be read, still waiting on a person: THE
 * answer every surface reads before it asks for a name (#3581). The photo was
 * taken as a receipt (the read stamped `receipt_read_failed`, or, on a row
 * written before that stamp existed, the shape check called it a receipt),
 * nothing named it, no read is running, and the person has not said to treat
 * it as one item. A failed read is a state with Read again, not an item: the
 * review surface used to reason from "no name" and asked the person to name
 * a receipt.
 */
export function scanReceiptReadFailed(row: ScanTriageRow): boolean {
  if (!isPending(row) || isNamed(row)) return false;
  const meta = metaOf(row);
  if (meta.read_as_item || meta.reading_receipt) return false;
  return !!meta.receipt_read_failed || meta.receipt_shape?.verdict === "receipt";
}

/** The session a photographed receipt is ALREADY in, when that is why its
 *  read stopped: the receipt door recognised the same receipt (same store and
 *  order, or the same lines) and did not import it twice. Not a failure to
 *  read, and never to be reported as "no line items" (#4027). */
export interface ScanReceiptAlreadyIn {
  batch_id: string;
  label: string | null;
  lines: number;
}
export function scanReceiptAlreadyIn(row: ScanTriageRow): ScanReceiptAlreadyIn | null {
  const d = (metaOf(row).receipt_read_failed as { duplicate_of?: Partial<ScanReceiptAlreadyIn> } | undefined)?.duplicate_of;
  if (!d || typeof d.batch_id !== "string" || !d.batch_id) return null;
  return { batch_id: d.batch_id, label: typeof d.label === "string" ? d.label : null, lines: typeof d.lines === "number" ? d.lines : 0 };
}

/** A route the matchmaker suggested. Only what the readiness rule needs. */
export interface ScanTopCandidate {
  module?: string;
  kind?: string;
  /** How a no-AI route earned its place; "keywords" is a guess the card renders
   *  tentative and no bulk sweep may commit. */
  basis?: string;
}

/** The matchmaker's top route, whatever shape the list arrived in. */
export function scanTopCandidate(row: ScanTriageRow): ScanTopCandidate | null {
  let list = row.suggested_candidates;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const top = list[0] as unknown;
  return top && typeof top === "object" ? (top as ScanTopCandidate) : null;
}

/** Didn't cleanly resolve: no name yet, a low-trust or rate-limited lookup,
 *  low confidence, or a field that says it was acquired somewhere the
 *  purchase evidence contradicts (acquisition-source.ts, #3008). "Looks
 *  fine" (a human eyeballed it) clears the flag — the point is to stop
 *  nagging, not to record a permanent doubt. */
/**
 * A row matched to a thing the workspace has, by an identifier the PERSON gave
 * (a part number in a hint, core#4552), files into that thing under its own
 * name: how sure the web was of a name for the identifier decides nothing
 * about it. Only that doubt is set aside (the confidence number, the low-trust
 * flag); a source or evidence conflict still holds the row.
 */
export function withoutVouchedNameDoubt(row: ScanTriageRow): ScanTriageRow {
  const meta = metaOf(row) as Record<string, unknown>;
  const stamps = (meta.field_provenance ?? {}) as Record<string, { by?: unknown } | undefined>;
  if (stamps.identifier?.by !== "person" || scanTrackedMatch(row)?.matched_by !== "identifier") return row;
  return { ...row, ai_confidence: null, suggested_metadata: { ...meta, low_trust: false } };
}

/** The fields a document read put in doubt (its own checks did not pass on
 *  them), and whether the document model is still to read the page. Null
 *  when nothing is in doubt. Written by the receipt reader (document-read.ts)
 *  on the item the document is about. */
export function scanCheckFields(row: ScanTriageRow): { fields: string[]; waiting: boolean; limit?: boolean } | null {
  const c = (metaOf(row) as { check_fields?: { fields?: unknown; waiting_for_ai?: unknown; waiting_reason?: unknown } }).check_fields;
  const fields = Array.isArray(c?.fields) ? (c!.fields as unknown[]).filter((f): f is string => typeof f === "string" && !!f) : [];
  return fields.length ? { fields, waiting: c?.waiting_for_ai === true, ...(c?.waiting_for_ai === true && c?.waiting_reason === "limit" ? { limit: true } : {}) } : null;
}

// VOCAB-ENUMERATION OK: the words for the fields a sale document's checks name
const CHECK_FIELD_WORDS: Record<string, string> = { vin: "the VIN", year: "the year", name: "the name", make: "the make", model: "the model", price: "the price", total: "the total", deposit: "the deposit", seller: "the seller" };

/** "Please check the VIN and the year: the page did not read clearly." */
export function checkFieldsWords(checks: { fields: string[]; waiting: boolean; limit?: boolean }, fieldLabel?: (name: string) => string): string {
  if (checks.limit) return CHECK_FIELDS_LIMIT_SENTENCE;
  const words = checks.fields.map((f) => CHECK_FIELD_WORDS[f] ?? `the ${(fieldLabel?.(f) ?? f.replace(/_/g, " ")).toLowerCase()}`);
  const list = words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return fillSentence(checks.waiting ? CHECK_FIELDS_WAITING_SENTENCE : CHECK_FIELDS_SENTENCE, { fields: list });
}

export function needsScanReview(row: ScanTriageRow): boolean {
  if (!isPending(row)) return false;
  // An unmet requirement is not a doubt: nothing files without a name, so
  // "Looks fine" cannot retire it. It used to, which hid the review block
  // while Add stayed disabled for want of the name (#3616).
  if (!isNamed(row)) return true;
  const meta = metaOf(row);
  if (meta.reviewed) return false;
  const confidence = row.ai_confidence == null ? null : Number(row.ai_confidence);
  return (
    !!meta.low_trust ||
    !!meta.rate_limited ||
    (confidence != null && !Number.isNaN(confidence) && confidence < SCAN_REVIEW_CONFIDENCE) ||
    scanSourceConflict(row) !== null ||
    scanCheckFields(row) !== null ||
    // A field the row's own evidence contradicts (the cover, the decoded
    // code) holds the row whatever the confidence number says: the number
    // is the identification's, not the field's (#3070, scan-evidence.ts).
    scanEvidenceConflicts(row).length > 0
  );
}

/**
 * Whether "Looks fine" settles this row's review: the ONE rule for offering
 * it, on every surface (#3616). A person saying "I looked, it's fine"
 * resolves a doubt (a low confidence, a flagged read, a guessed route, a
 * source conflict), never an unmet requirement: a row with no name still
 * cannot file after the tap, so offering it there was an affordance that
 * lied. Decided by applying the tap: true only when the row, marked
 * reviewed, no longer needs review.
 */
export function scanLooksFineResolves(row: ScanTriageRow): boolean {
  if (!needsScanReview(row)) return false;
  const meta = { ...(metaOf(row) as Record<string, unknown>), reviewed: true };
  return !needsScanReview({ ...row, suggested_metadata: meta });
}

/**
 * A doubt the pipeline raised about the identification (`low_trust`) that no
 * person has retired yet: pending, flagged, not `reviewed`. THE answer to
 * "is this row's doubt still open" (#3057). "Looks fine" sets `reviewed`, and
 * the tap that sets it disappears with the review block, so a surface that
 * re-derives the doubt from the raw flag draws a warning nobody can dismiss:
 * the phone row, the item screen and the desktop card each did, from three
 * different reads. Every surface reads this instead
 * (`lint:scan-doubt-from-contract`).
 */
export function scanDoubtOpen(row: ScanTriageRow): boolean {
  const meta = metaOf(row);
  return isPending(row) && !!meta.low_trust && !meta.reviewed;
}

/** What kind of doubt it is, while it is open; null otherwise. */
export type ScanDoubt = "short-barcode" | "split-group" | "split-siblings" | "untrusted";

export function scanDoubt(row: ScanTriageRow): ScanDoubt | null {
  if (!scanDoubtOpen(row)) return null;
  const meta = metaOf(row);
  if (meta.split_review) return "split-group";
  if (meta.split_disagreed?.length) return "split-siblings";
  if (isShortBarcode(row.barcode_text)) return "short-barcode";
  return "untrusted";
}

/** The doubt as the card's one sentence, rendered from the row's state, or
 *  null when no doubt is open. A short barcode's is the card sentence
 *  (scan-copy) whatever the note says, since the note is provenance. Every
 *  other doubt is in the pipeline's own words when it wrote them (a split's
 *  crop that could not be cut, the pieces that disagree), else the kind's
 *  sentence. */
export function scanDoubtWords(row: ScanTriageRow): string | null {
  const kind = scanDoubt(row);
  if (!kind) return null;
  if (kind === "short-barcode") return SHORT_BARCODE_DOUBT;
  const own = scanProvenanceNote(row.ai_notes);
  if (own) return own;
  if (kind === "split-group") return SPLIT_GROUP_DOUBT;
  if (kind === "split-siblings") return SPLIT_SIBLINGS_DOUBT;
  return UNTRUSTED_DOUBT;
}

/** A short product code: fewer than the twelve digits of a UPC-A / EAN-13
 *  (an EAN-8, a UPC-E, a truncated read). The lookup flags these low_trust. */
export function isShortBarcode(code: string | null | undefined): boolean {
  const digits = (code ?? "").replace(/\D/g, "");
  return /^\d+$/.test(code ?? "") && digits.length >= 6 && digits.length < 12;
}

/** The warning the lookup used to bake into the stored note, in every
 *  spelling it shipped with (the em dash, the hyphen, the ASCII arrow). */
const BAKED_DOUBT = /\s*(?:\u26a0\ufe0f?\s*)?Short barcode\s*[\u2014\u2013-]+\s*double-check this is the right product\.?/gi;

/** The note as provenance only: the doubt the lookup once baked into it is
 *  stripped at render, so a row written before #3057 reads the same as one
 *  written after and needs no data heal. Null when nothing is left. */
export function scanProvenanceNote(notes: string | null | undefined): string | null {
  if (!notes) return null;
  // The photo check's line is a live status, never provenance: whatever the
  // stored note says, a finished (or dead) check must not read as running.
  const out = notes.replace(BAKED_DOUBT, "").split(PHOTO_CHECK_NOTE).join("").replace(/\s{2,}/g, " ").trim();
  return out || null;
}

/** The contradiction between where a row says it was acquired and what its
 *  purchase evidence says, or null. Served on every row as `source_conflict`
 *  beside `review_reason`; derived, never stored. */
export function scanReviewSourceConflict(row: ScanTriageRow): SourceConflict | null {
  return scanSourceConflict(row);
}

/** Why the row still needs a person, in words, or null when nothing is
 *  flagged. The card shows it where Add would be, and the File preview lists
 *  the row under "left for you" with it. A flagged row's own note is the
 *  pipeline's sentence about what went wrong, so it is the reason when there
 *  is one; the short phrases cover a row that was flagged without a note. */
export function scanReviewReason(
  row: ScanTriageRow,
  opts: {
    /** The label a field wears on this table ("Acquired from" for
     *  acquired_from), when the caller has the table; the name otherwise. */
    fieldLabel?: (name: string) => string;
  } = {},
): string | null {
  if (!needsScanReview(row)) return null;
  const meta = metaOf(row);
  // Before "no name": a receipt whose read failed is not an unnamed item.
  if (scanReceiptReadFailed(row)) return RECEIPT_UNREAD_SENTENCE;
  if (!isNamed(row)) return classifiedCodeOf(meta)?.note ?? NO_NAME_SENTENCE;
  if (meta.rate_limited) return THROTTLED_SENTENCE;
  // A row nothing tried to read (no provider here) was not one the AI could
  // not read: the reason it is flagged is the next one down (#3233).
  if (meta.identify_failure && !identifyNeverTried(meta.identify_failure as IdentifyFailure)) return AI_FAILED_SENTENCE;
  // Said before the trust and confidence reasons: it names the exact value
  // to look at, where those only say "check it".
  const conflict = scanSourceConflict(row);
  if (conflict) return sourceConflictWords(conflict, opts.fieldLabel?.(conflict.field));
  const contradicted = scanEvidenceConflicts(row)[0];
  if (contradicted) return evidenceConflictWords(contradicted, opts.fieldLabel?.(contradicted.field));
  const checks = scanCheckFields(row);
  if (checks) return checkFieldsWords(checks, opts.fieldLabel);
  if (meta.low_trust) return scanDoubtWords(row) ?? UNTRUSTED_DOUBT;
  const confidence = Number(row.ai_confidence);
  return fillSentence(LOW_CONFIDENCE_SENTENCE, { pct: Math.round(confidence * 100) });
}

/** One answer a question offers, and where it came from. */
export interface ScanQuestionChoice {
  value: string;
  /** Why this answer is on offer: 'the name says "4 Ply"', "the AI's read". */
  source: string;
}

/** The ONE thing a flagged row still asks of a person, as a question with
 *  its answers, rather than the pipeline's whole sentence about what went
 *  wrong. A card foregrounds the question and the tap that resolves it; the
 *  sentence stays in the evidence (#3009: a percentage or a paragraph is not
 *  a decision). `field` is the table field the answer sets, or null when
 *  the question is about the identification as a whole. */
export interface ScanQuestion {
  field: string | null;
  /** The answer is the row's NAME, not a table field: a tap names the row
   *  the way a typed name does (a person's choice, stamped person), never
   *  the lookup's own confidence. Set with `field: null`. */
  names?: true;
  /** "Check weight class", "Fiber is not set", "Check the name". */
  prompt: string;
  /** Tap answers; empty when the answer has to be typed. */
  choices: ScanQuestionChoice[];
  /** One line of why, for a title or a second line. */
  because: string;
}

const humanField = (k: string) => k.replace(/_/g, " ");

/** The questions a flagged row still asks, in the order to ask them. A
 *  value the purchase evidence contradicts (#3008) and a fact the name
 *  overruled the model on are two-answer questions until a person sets the
 *  field; a field the pieces of one photo disagreed on is a typed question;
 *  a crop that failed, a throttled lookup, an AI that did not answer or a
 *  low score asks about the identification itself, with the row's own
 *  sentence as the reason when it has one and the score only when it does
 *  not. Empty when nothing is flagged, or once a person said "looks fine". */
export function scanReviewQuestions(row: ScanTriageRow): ScanQuestion[] {
  if (!needsScanReview(row)) return [];
  const meta = metaOf(row);
  const typed = meta.user_fields?.values ?? {};
  const answered = (field: string) => typed[field] != null && String(typed[field]).trim() !== "";
  const out: ScanQuestion[] = [];
  // A receipt whose read failed asks to be read again, not named (#3581).
  if (scanReceiptReadFailed(row)) return out;
  if (!isNamed(row)) {
    // A web guess held for want of a second source is shown as a guess a
    // tap can take. It used to be prose in the note beside an empty name
    // field, so a person read the right name and typed it back by hand
    // (five of fourteen codes from a visitor's pocket, 2026-09-20). One
    // source never NAMES a thing; it may ASK. A store's own code has no
    // web guess worth asking about (#3017).
    const held = typeof meta.held_name === "string" ? meta.held_name.trim() : "";
    const label = typeof meta.label_text === "string" ? meta.label_text.trim() : "";
    if (label) {
      out.push({ field: null, names: true, prompt: HELD_GUESS_PROMPT, choices: [{ value: label, source: LABEL_GUESS_SOURCE }], because: LABEL_GUESS_BECAUSE });
    } else if (held && classifiedCodeOf(meta)?.type !== "store-code") {
      out.push({ field: null, names: true, prompt: HELD_GUESS_PROMPT, choices: [{ value: held, source: HELD_GUESS_SOURCE }], because: HELD_GUESS_BECAUSE });
    } else {
      out.push({ field: null, prompt: "Name it", choices: [], because: "nothing could name this" });
    }
    return out;
  }
  const conflict = scanSourceConflict(row);
  if (conflict && !answered(conflict.field)) {
    const said = conflict.from === "receipt" ? "the receipt says" : conflict.from === "order" ? "the order says" : "the import says";
    out.push({
      field: conflict.field,
      prompt: `Check ${humanField(conflict.field)}`,
      choices: [
        { value: conflict.evidence, source: `${said}${conflict.seller ? ` (sold by ${conflict.seller})` : ""}` },
        { value: conflict.value, source: "the field says" },
      ],
      because: `the field says ${conflict.value}, but ${said} ${conflict.evidence}`,
    });
  }
  // The evidence on the row against what it asserts: both values are taps,
  // the evidence first, and the sentence says where each came from (#3070).
  for (const c of scanEvidenceConflicts(row)) {
    if (answered(c.field)) continue;
    out.push({
      field: c.field,
      prompt: `Check ${humanField(c.field)}`,
      choices: [
        { value: c.evidence, source: `${c.label} says` },
        { value: c.claimed, source: "the AI says" },
      ],
      because: `${c.label} says ${c.evidence}; the AI says ${c.claimed}`,
    });
  }
  for (const f of meta.name_facts ?? []) {
    if (!f.was || answered(f.field)) continue;
    out.push({
      field: f.field,
      prompt: `Check ${humanField(f.field)}`,
      choices: [
        { value: f.value, source: `the name says "${f.said}"` },
        { value: f.was, source: "the AI's read" },
      ],
      because: `the name says "${f.said}" and the AI read "${f.was}"`,
    });
  }
  for (const field of meta.split_disagreed ?? []) {
    if (answered(field)) continue;
    out.push({
      field,
      prompt: `${humanField(field)[0]!.toUpperCase()}${humanField(field).slice(1)} is not set`,
      choices: [],
      because: "the pieces split from one photo did not agree on it",
    });
  }
  if (out.length) return out;
  // The identification itself: the row's one sentence (scanReviewReason),
  // split into the problem and the action, so the question's heading is
  // the thing to do and its line is why. Never the router's paragraph
  // (`ai_notes`): that is provenance, and it stays in Source data (#3063).
  const sentence = scanReviewReason(row) ?? UNTRUSTED_DOUBT;
  const { problem, action } = splitSentence(sentence);
  out.push({ field: null, prompt: action ?? "Check the name", choices: [], because: problem });
  return out;
}

/** A card sentence is "{problem}. {action}." (scan-copy's 70-char rule);
 *  the last clause is the action, everything before it the problem. A
 *  one-clause sentence is all problem. */
function splitSentence(sentence: string): { problem: string; action: string | null } {
  const clauses = sentence.replace(/[.\s]+$/, "").split(/\.\s+/);
  if (clauses.length < 2) return { problem: clauses[0] ?? sentence, action: null };
  return { problem: clauses.slice(0, -1).join(". "), action: clauses[clauses.length - 1]! };
}

/** Ready to file: named, routed, and nothing left to ask. THE rule behind
 *  every one-tap or bulk commit (the card's Add, File, File N, the File
 *  preview, the assistant's plan). A row the pipeline flagged for review is
 *  never ready, however confident its route, because the flag exists to stop
 *  exactly that commit until a person has looked; "looks fine" clears it.
 *
 *  A keyword-basis route is not a route: it is a no-AI guess held up only by
 *  corroborating keyword hits, the tier that once filed a storage tote into
 *  Vehicles because a marketing description grazed "car(ds)". The card
 *  renders those tentative, and a bulk sweep may not commit what the card
 *  will not one-tap. */
export function isScanReadyToFile(row: ScanTriageRow, ctx: ScanRowStateContext = {}): boolean {
  if (!isPending(row)) return false;
  const e = scanRowState(row, ctx).eligibility;
  return e === "ready" || e === "needs-install";
}

// ── The row's state: one answer for eligibility, sentence, action and
// destination (#3059 Engine 1: #3076, #3063, #3062). The list row, the item
// screen, the desktop card and the session strip each used to decide for
// themselves whether a row was ready, what was wrong and what the button
// said, so one screenshot showed Add, the next Review, and the session
// offered File 1 for the same item. A surface RENDERS what is below; it does
// not derive its own (`lint:scan-state-from-contract`).

export type ScanEligibility = "ready" | "needs-review" | "needs-install" | "blocked";

/** Where the row is headed, and who decided. `chosenBy: "person"` is a
 *  choice stored on the row by a person (DESTINATION_KEY); the value alone
 *  cannot tell a system pick from a person picking the same table on
 *  purpose, which is why it is stored, never inferred (#3062). */
export interface ScanDestination {
  module: string;
  instance: string | null;
  kind: string | null;
  label: string;
  /** Filing installs a bundle first (the offer on the candidate). */
  installs: boolean;
  bundle_external_id: string | null;
  chosenBy: "person" | "system";
  /** The route the matchmaker stored, when the answer above replaced it
   *  (a better table the workspace gained since): what the chip offers to
   *  go back to. Null when nothing was replaced. */
  replaced: { module: string; instance: string | null; label: string } | null;
  /** For a PERSON's choice, which is never replaced: the table the router's
   *  rule would put it in instead, offered and only offered. Null when the
   *  choice is where the router would put it too, or for a system route
   *  (there the better table IS the destination and `replaced` says so). */
  offered: { module: string; instance: string | null; kind: string | null; label: string } | null;
  /** The record filing this row UPDATES instead of creating one (a
   *  re-purchase of something the workspace counts): the destination is
   *  then that record's table, whatever the route or an earlier pick said,
   *  because that is where the write lands (#3707). Null when filing
   *  creates. */
  updates: ScanMergeTarget | null;
}

/** The stored choice a person made on the row. */
export const DESTINATION_KEY = "destination";
export interface StoredDestination {
  module: string;
  instance: string | null;
  kind?: string | null;
  label?: string | null;
  by: "person" | "system";
  at?: string;
}

export function storedDestinationOf(meta: unknown): StoredDestination | null {
  const d = ((meta ?? {}) as Record<string, unknown>)[DESTINATION_KEY];
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (typeof o.module !== "string" || !o.module) return null;
  return {
    module: o.module,
    instance: typeof o.instance === "string" && o.instance ? o.instance : null,
    kind: typeof o.kind === "string" ? o.kind : null,
    label: typeof o.label === "string" ? o.label : null,
    by: o.by === "person" ? "person" : "system",
    ...(typeof o.at === "string" ? { at: o.at } : {}),
  };
}

/** Where a filed row actually went, stamped on the row when it was filed
 *  (#3620): the table by module and instance, and its name then. A
 *  committed row is shown by THIS, never re-derived from its candidates:
 *  a filing into Groceries read back as "Inventory · Groceries?" because
 *  the row only kept the module's base kind. */
export const FILED_INTO_KEY = "filed_into";
export interface FiledInto {
  module: string;
  instance: string | null;
  kind: string | null;
  label: string;
  /** The record's name as it was filed: what the person confirmed, never
   *  the listing title a catalog suggested (#4011). */
  name?: string;
  /** What one record of the table is called ("spool"). */
  noun?: string;
  /** The type the record was filed under, when its table has a parent type
   *  table (a spool under "Royal Blue PLA"), and whether filing made it. */
  under?: { id: string; name: string; created: boolean; instance: string };
}
export function filedIntoOf(meta: unknown): FiledInto | null {
  const f = ((meta ?? {}) as Record<string, unknown>)[FILED_INTO_KEY];
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  if (typeof o.module !== "string" || !o.module || typeof o.label !== "string" || !o.label.trim()) return null;
  return {
    module: o.module,
    instance: typeof o.instance === "string" && o.instance ? o.instance : null,
    kind: typeof o.kind === "string" && o.kind ? o.kind : null,
    label: o.label,
    ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim() } : {}),
    ...(typeof o.noun === "string" && o.noun.trim() ? { noun: o.noun.trim() } : {}),
    ...(underOf(o.under) ? { under: underOf(o.under)! } : {}),
  };
}

function underOf(v: unknown): FiledInto["under"] | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  if (typeof u.id !== "string" || !u.id || typeof u.name !== "string" || typeof u.instance !== "string" || !u.instance) return null;
  return { id: u.id, name: u.name, created: u.created === true, instance: u.instance };
}

/** A workspace's scan menu entry, as both the web and the server hold it. */
export interface ScanMenuTableEntry {
  module: string;
  instance: string | null;
  kind: string;
  noun: string;
  label: string;
  fields: ReadonlyArray<{ name: string }>;
  category_field?: { name?: string; label: string; values: string[] };
  scan_keywords?: string[];
  bundle_external_id?: string | null;
}

/** The scan menu as the destination resolver reads it: the destination
 *  shape beside the fit shape the router reads. ONE builder for the card,
 *  the page's File N and every server reader of an item's destination
 *  (#3618), so the tables they hand the resolver are the same tables. */
export function scanResolverTables(menu: ReadonlyArray<ScanMenuTableEntry> | null | undefined): ScanResolverTable[] {
  return (menu ?? []).map((m) => ({
    ...m,
    instance_name: m.instance ?? m.module,
    display_name: m.label,
    module_name: m.module,
    keywords: m.scan_keywords ?? [],
    kind: m.kind,
    bundle_external_id: m.bundle_external_id ?? null,
  })) as unknown as ScanResolverTable[];
}

/** A candidate as the served row carries it: only what the destination
 *  needs. */
export interface ScanDestinationCandidate {
  module?: string;
  instance?: string | null;
  kind?: string;
  label?: string;
  basis?: string;
  bundle_external_id?: string | null;
}

/** A workspace table as the resolver reads it: the destination shape (the
 *  instance, its module, its label and kind) and, for the better-table
 *  question, the fit shape the router reads (noun, fields, scan_keywords,
 *  category_field). The web's scan menu entries carry both. A table handed
 *  in without the fit shape can be filed into and labelled, never nudged
 *  to: the resolver holds no second rule for that. */
export type ScanResolverTable = DestinationTable & { kind?: string | null; bundle_external_id?: string | null } & Partial<FitTable>;

export interface ScanDestinationContext {
  /** The workspace's routable tables (the menu), for a better table the
   *  workspace gained since the route was stored, and for a stored choice's
   *  label. */
  tables?: readonly ScanResolverTable[];
}

/** What the fit rule reads off a row: its own words, its maker, what the
 *  catalog said it is. The same evidence the router had. */
export function scanFitItem(row: ScanTriageRow): FitItem {
  const meta = metaOf(row) as { category?: unknown; description?: unknown };
  const cands = candidatesOf(row) as Array<{ category?: unknown; is_a?: unknown }>;
  const top = cands[0];
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  // What the matchmaker said the item IS ("3D printer") stands in for a
  // category when there is none: a typed "Bambu Lab P1P" has no catalog
  // category, and without it a catch-all never yields to the list made for
  // exactly this kind (#5065).
  const isA = cands.map((c) => text(c?.is_a)).find((v): v is string => !!v) ?? null;
  return {
    name: row.suggested_name ?? "",
    manufacturer: text(row.suggested_manufacturer) ?? null,
    category: text(top?.category) ?? text(meta.category) ?? isA,
    description: text(meta.description) ?? null,
  };
}

const isFitTable = (t: ScanResolverTable): t is ScanResolverTable & FitTable => typeof t.noun === "string" && Array.isArray(t.fields);

/**
 * The table an item fits better than the one it is headed to, by THE
 * router's rule (table-fit.ts: a noun, a head-noun hit or two corroborating
 * keywords; the catalog's category outranks a grazed word; the narrower
 * table first), or null. One rule, so the chip cannot argue with the route:
 * the nudge used to be its own one-whole-word rule with no floor and no
 * category, and every product whose brand is a fruit was offered Groceries
 * (#3136). The table the item is IN fitting means nothing else argues.
 */
export function scanBetterTable(item: FitItem, currentKind: string | null | undefined, tables: readonly ScanResolverTable[], module?: string | null): ScanResolverTable | null {
  const fit = tables.filter(isFitTable);
  if (fit.length === 0 || !item.name.trim()) return null;
  const head = normaliseTargetKind(currentKind, module).split(":")[0] ?? "";
  const fits = rankFits(item, fit);
  if (fits.length === 0) return null;
  // A module's catch-all yields to a list of its own that fits: the most
  // specific collection wins, 3D Printers over Machines (#4591).
  const onCatchAll = !!module && head === module;
  const ownList = onCatchAll ? fits.find((f) => (f.table.module_name ?? null) === module && f.table.instance_name !== head) : undefined;
  if (ownList) return ownList.table;
  if (fits.some((f) => f.table.instance_name === head)) return null;
  const best = fits[0]!.table;
  return best.instance_name === head ? null : best;
}

function candidatesOf(row: ScanTriageRow): ScanDestinationCandidate[] {
  let list = row.suggested_candidates;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? (list.filter((c) => c && typeof c === "object") as ScanDestinationCandidate[]) : [];
}

const sameTable = (a: { module?: string | null; instance?: string | null }, b: { module?: string | null; instance?: string | null }): boolean =>
  (a.module ?? "") === (b.module ?? "") && (a.instance ?? null) === (b.instance ?? null);

/**
 * Where the row is headed. THE OWNER'S RULING (#3062): a destination the
 * system chose and the person never touched MAY be replaced by a better
 * system suggestion (a table the workspace gained since, claimed by the
 * item's own words); a destination a person chose is never replaced, even
 * when they picked the very table the system had suggested. So a stored
 * person choice wins outright; otherwise the matchmaker's top route stands
 * unless the workspace now has a better table, in which case that table is
 * the destination and the old route is kept as `replaced` for the chip.
 */
export function scanDestination(row: ScanTriageRow, ctx: ScanDestinationContext = {}): ScanDestination | null {
  const tables = ctx.tables ?? [];
  const tableOf = (module: string, instance: string | null) =>
    tables.find((t) => (t.module_name ?? null) === module && (t.instance_name ?? null) === (instance ?? module)) ??
    tables.find((t) => (t.instance_name ?? null) === (instance ?? module));
  const stored = storedDestinationOf(row.suggested_metadata);
  const cands = candidatesOf(row);
  // A re-purchase is filed onto the record it matched, so THAT record's
  // table is where the item goes. The card said Inventory beside "+1 more"
  // while Replaced wrote to the milk in Groceries (#3707).
  const updates = scanMergeTarget(row, ctx);
  if (updates) {
    const table = tableOf(updates.module, updates.instance);
    const cand = cands.find((c) => sameTable(c, updates));
    return {
      module: updates.module,
      instance: updates.instance,
      kind: table?.kind ?? cand?.kind ?? updates.kind,
      label: table?.display_name ?? cand?.label ?? updates.instance ?? updates.module,
      installs: false,
      bundle_external_id: null,
      chosenBy: stored?.by === "person" ? "person" : "system",
      replaced: null,
      offered: null,
      updates,
    };
  }
  if (stored?.by === "person") {
    const table = tableOf(stored.module, stored.instance);
    const cand = cands.find((c) => sameTable(c, stored));
    return {
      module: stored.module,
      instance: stored.instance,
      kind: stored.kind ?? cand?.kind ?? table?.kind ?? null,
      label: stored.label ?? cand?.label ?? table?.display_name ?? table?.instance_name ?? stored.module,
      installs: !!(cand?.bundle_external_id ?? table?.bundle_external_id),
      bundle_external_id: cand?.bundle_external_id ?? table?.bundle_external_id ?? null,
      chosenBy: "person",
      replaced: null,
      offered: (() => {
        if (!isPending(row)) return null;
        const b = scanBetterTable(scanFitItem(row), stored.kind ?? cand?.kind ?? table?.kind ?? null, tables, stored.module);
        return b ? { module: b.module_name ?? b.instance_name, instance: b.instance_name, kind: b.kind ?? null, label: b.display_name ?? b.instance_name } : null;
      })(),
      updates: null,
    };
  }
  const top = cands[0];
  if (!top?.module) return null;
  const system: ScanDestination = {
    module: top.module,
    instance: top.instance ?? null,
    kind: top.kind ?? null,
    label: top.label ?? top.module,
    installs: !!top.bundle_external_id,
    bundle_external_id: top.bundle_external_id ?? null,
    chosenBy: "system",
    replaced: null,
    offered: null,
    updates: null,
  };
  if (!isPending(row) || tables.length === 0) return system;
  const entry = scanBetterTable(scanFitItem(row), system.kind, tables, system.module);
  if (!entry || sameTable({ module: entry.module_name ?? entry.instance_name, instance: entry.instance_name }, system)) return system;
  return {
    module: entry.module_name ?? entry.instance_name,
    instance: entry.instance_name,
    kind: entry.kind ?? null,
    label: entry.display_name ?? entry.instance_name,
    installs: !!entry.bundle_external_id,
    bundle_external_id: entry.bundle_external_id ?? null,
    chosenBy: "system",
    replaced: { module: system.module, instance: system.instance, label: system.label },
    offered: null,
    updates: null,
  };
}

/** The row's table is in an app this person cannot reach: absent from the
 *  deployment, or off here and they may not turn it on (#3610). The card
 *  says Ask or Pick another table for it; a count of what is ready must not
 *  include it. Unknown module state is never unreachable. */
export function scanDestinationUnreachable(row: ScanTriageRow, ctx: ScanRowStateContext): boolean {
  const d = scanDestination(row, ctx);
  if (!d || d.installs) return !!d?.installs && ctx.canInstall === false;
  const state = ctx.moduleState?.(d.module);
  return state === "absent" || (state === "available" && ctx.canInstall === false);
}

export interface ScanRowStateContext extends ScanDestinationContext {
  /** The person may file into THIS table (the capability): asked with the
   *  resolved destination's module, so a session of rows routed to
   *  different tables gets one answer per row (create-capability.ts,
   *  /me/capabilities). Null or undefined is "not known yet", which never
   *  blocks. Once a plain `permitted` boolean that nothing in the product
   *  set, so the blocked state never rendered (#3126). */
  permittedFor?: (module: string | null) => boolean | null | undefined;
  /** The person may install a bundle or turn on a module (the role).
   *  Default true. */
  canInstall?: boolean;
  /** Whether a module is turned on in this workspace: "enabled", "available"
   *  (this deployment has it; an admin can turn it on) or "absent" (it does
   *  not exist here, so nothing can be asked for). Null or undefined while
   *  it loads, which never blocks. The destination's table living in an app
   *  that is off is the same missing table as an uninstalled bundle (#3610):
   *  a ready Add there is refused by the server. */
  moduleState?: (module: string) => "enabled" | "available" | "absent" | null | undefined;
  /** The field's label on the destination's table, for the source-conflict
   *  sentence. */
  fieldLabel?: (name: string) => string;
}

/** The record the matchmaker found already tracking this thing, stamped on
 *  the row (`tracked_match`), or null. `counted` says the record keeps a
 *  count (its `qty` is a number), which is what makes "+1 more" the right
 *  filing; a record with no count is one unique thing. `kind`/`id` are
 *  null on a half-written stamp, which nothing may file through. */
export interface ScanTrackedMatch {
  title: string;
  matched_by: string | null;
  kind: string | null;
  id: string | null;
  instance: string | null;
  counted: boolean;
  /** How many THINGS matched as well as this one (the same tier: two on
   *  one barcode, or two by name with no barcode). Places of one item are one
   *  thing. Above 1 no machine can pick. A stamp from before the count reads 1. */
  of: number;
  /** How many places the matched thing is kept in (one card, a row per
   *  place). A stamp from before places reads 1. */
  places: number;
  /** Whether the stamp's record is the place this scan belongs to: the one
   *  somebody picked, or the place being worked in. Only matters when
   *  `places` is above 1. */
  placeChosen: boolean;
  /** The place this scan is at, when the matched thing is not kept there
   *  yet: filing it adds that place to the thing. */
  newPlace: string | null;
  /** Where the thing is kept already, in words ("8 in Kitchen"). */
  held: string | null;
}
export function scanTrackedMatch(row: ScanTriageRow): ScanTrackedMatch | null {
  const m = ((row.suggested_metadata ?? {}) as {
    tracked_match?: { title?: unknown; matched_by?: unknown; kind?: unknown; id?: unknown; instance?: unknown; qty?: unknown; of?: unknown; places?: unknown; place_chosen?: unknown; new_place?: unknown; held?: unknown } | null;
  }).tracked_match;
  if (!m || typeof m !== "object" || typeof m.title !== "string" || !m.title.trim()) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return {
    title: m.title,
    matched_by: str(m.matched_by),
    kind: str(m.kind),
    id: str(m.id),
    instance: str(m.instance),
    counted: typeof m.qty === "number" && Number.isFinite(m.qty),
    of: typeof m.of === "number" && Number.isFinite(m.of) && m.of > 1 ? Math.floor(m.of) : 1,
    places: typeof m.places === "number" && Number.isFinite(m.places) && m.places > 1 ? Math.floor(m.places) : 1,
    placeChosen: m.place_chosen === true,
    newPlace: str(m.new_place),
    held: str(m.held),
  };
}

/** What a merge files into: the tracked record, by the id the attach
 *  endpoint wants, and the table it lives in. */
export interface ScanMergeTarget {
  module: string;
  kind: string;
  id: string;
  instance: string | null;
  title: string;
  /** The scan is of this thing at a place it is not kept yet: filing adds a
   *  row for that place under the same item, never a second item and never
   *  a count on a place the scan is not at. */
  new_place?: string | null;
  /** Where it is kept already, in words ("8 in Kitchen"). */
  held?: string | null;
}

/** "Not the same, keep separate": the person's answer that this scan is not
 *  the record the matchmaker found. Stored with THAT record's id, so a
 *  re-run that finds a different record asks again. */
export const KEEP_SEPARATE_KEY = "keep_separate";
export function scanKeptSeparateFrom(meta: unknown): string | null {
  const k = ((meta ?? {}) as Record<string, unknown>)[KEEP_SEPARATE_KEY];
  if (!k || typeof k !== "object") return null;
  const id = (k as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}
/** The keep-separate answer to store for this row: against the record it
 *  is matched to now, or null when nothing is matched. */
export function scanKeepSeparateStamp(meta: unknown, at: string): { id: string; at: string } | null {
  const id = scanTrackedMatch({ suggested_metadata: meta })?.id;
  return id ? { id, at } : null;
}

/** The table the tracked record lives in. An instance's record carries the
 *  instance's own kind (`groceries:item`), so its module is the instance's
 *  module from the workspace's tables, never the kind's namespace; a base
 *  table's record is namespaced by its module (`inventory:part`). */
function trackedTable(t: ScanRecordRef, tables: readonly ScanResolverTable[]): { module: string; instance: string | null } | null {
  if (!t.kind) return null;
  if (t.instance) {
    const inst = tables.find((x) => x.instance_name === t.instance && x.module_name);
    const module = inst?.module_name ?? t.kind.split(":")[0] ?? "";
    return module ? { module, instance: t.instance === module ? null : t.instance } : null;
  }
  const module = t.kind.split(":")[0] ?? "";
  return module ? { module, instance: null } : null;
}

/** The person said this scan is NOT the tracked record: "keep separate" on
 *  that record, or a table of their own choosing other than the record's
 *  (picking where a NEW item goes is the same answer). An instance is
 *  named once per workspace, so a record in one is compared by instance. */
type ScanRecordRef = Pick<ScanTrackedMatch, "kind" | "id" | "instance">;
function matchDeclined(row: ScanTriageRow, t: ScanRecordRef, tables: readonly ScanResolverTable[]): boolean {
  if (t.id && scanKeptSeparateFrom(row.suggested_metadata) === t.id) return true;
  const stored = storedDestinationOf(row.suggested_metadata);
  if (stored?.by !== "person") return false;
  if (t.instance) return (stored.instance ?? stored.module) !== t.instance;
  const home = trackedTable(t, tables);
  return !!home && !sameTable(stored, home);
}

/** Whether the person has said this scan is not that record: for a door
 *  that finds matches live (File all's plan) rather than reading the stamp,
 *  so a declined record is never fed by a bulk action either. */
export function scanDeclinesRecord(row: ScanTriageRow, rec: ScanRecordRef, ctx: ScanDestinationContext = {}): boolean {
  return matchDeclined(row, rec, ctx.tables ?? []);
}

/**
 * The record filing this row updates instead of creating, or null. ONE
 * answer for the destination (the record's table), the action (+1 more)
 * and every door that files (#3707): a pending re-purchase of a record
 * the workspace counts, that nobody has said is a different thing
 * ("Looks fine", keep separate, or a table picked for a new one).
 */
export function scanMergeTarget(row: ScanTriageRow, ctx: ScanDestinationContext = {}): ScanMergeTarget | null {
  const r = scanRebuy(row, ctx);
  return r.kind === "adds" ? r.to : null;
}

/** What the row's match means for filing, the one answer every door reads:
 *  the card's button, File N, the dashboard and File everything's plan
 *  (#3726: the card offered +1 from the match stamped under the old name
 *  while File everything matched the new name live and planned a new
 *  record). `adds`: filing adds to that record. `hold`: a person decides
 *  first, and the sentence says why. `none`: filing creates. */
export type ScanRebuy =
  | { kind: "adds"; to: ScanMergeTarget; matchedBy: string | null }
  | { kind: "hold"; sentence: string }
  | { kind: "none" };

export function scanRebuy(row: ScanTriageRow, ctx: ScanDestinationContext = {}): ScanRebuy {
  if (!isPending(row) || metaOf(row).reviewed) return { kind: "none" };
  const t = scanTrackedMatch(row);
  if (!t) return { kind: "none" };
  // Paperwork for a thing you have is put on it, never counted as another.
  if (isPaperworkMatch(row, t)) return { kind: "hold", sentence: fillSentence(PAPERWORK_SENTENCE, { title: t.title }) };
  const tables = ctx.tables ?? [];
  // "Not A" is no evidence for B: turning down one of several equal matches
  // still leaves a choice only a person can make.
  if (matchDeclined(row, t, tables)) return t.of > 1 ? { kind: "hold", sentence: fillSentence(AMBIGUOUS_MATCH_SENTENCE, { n: t.of }) } : { kind: "none" };
  if (t.of > 1) return { kind: "hold", sentence: fillSentence(AMBIGUOUS_MATCH_SENTENCE, { n: t.of }) };
  // One thing, kept in several places: adding to it means adding to ONE
  // place, and "+1 more" into a place nobody chose files a vehicle's delivery
  // in the closet. Asked once; the pick (or the place being worked in) is
  // what the stamp's record already is.
  if (t.places > 1 && !t.placeChosen && !t.newPlace) return { kind: "hold", sentence: fillSentence(WHICH_PLACE_SENTENCE, { n: t.places }) };
  // A record with no count is one unique thing, and "+1" would double it.
  if (!t.counted || !t.kind || !t.id) return { kind: "hold", sentence: DUPLICATE_SENTENCE };
  const home = trackedTable(t, tables);
  if (!home) return { kind: "hold", sentence: DUPLICATE_SENTENCE };
  return {
    kind: "adds",
    to: { module: home.module, kind: t.kind, id: t.id, instance: t.instance, title: t.title, ...(t.newPlace ? { new_place: t.newPlace, held: t.held } : {}) },
    matchedBy: t.matched_by,
  };
}

export interface ScanRowState {
  eligibility: ScanEligibility;
  /** The one sentence: the problem and what to do. Null when ready and
   *  nothing is worth saying; a merge says what adding does. */
  sentence: string | null;
  /** What the button says, and what it does. Same words on every surface.
   *  `merge` is +1 more of a record the workspace counts, filed through
   *  `merge` below rather than created. */
  action: { kind: "add" | "install-add" | "merge" | "review" | "blocked"; label: string; title: string };
  destination: ScanDestination | null;
  /** The record a `merge` action adds to. Null for every other action. */
  merge: ScanMergeTarget | null;
  /** What a `blocked` row would ask an admin for (blocked-action.ts): the
   *  create capability the destination's module gates on, the bundle the
   *  destination installs, or both. The surface hands these to the
   *  approval seam; the words come back from the server. Null unless
   *  blocked. */
  ask: Array<{ kind: "capability" | "install" | "module"; key: string }> | null;
}

/**
 * The row's state, resolved once. Eligibility, in order of what a person
 * must settle first: blocked (they cannot file here) > needs-review (no
 * name, a doubt, a duplicate the workspace already tracks, a keyword-only
 * route) > needs-install (the destination is a table to install) > ready.
 * "Looks fine" (`reviewed`) retires every doubt in the review tier, the
 * duplicate and the keyword guess included; nothing retires an install or
 * a missing permission. A person's own destination choice is never a guess,
 * whatever the matchmaker's basis was.
 */
export function scanRowState(row: ScanTriageRow, ctx: ScanRowStateContext = {}): ScanRowState {
  // A receipt whose lines could not be read is not an item yet, so it has no
  // table to be filed into: its actions are Read again, or "Treat it as one
  // item" on purpose (#3581). A destination here drew a table picker and a
  // Review button on a thing nobody can file.
  if (scanReceiptReadFailed(row)) {
    const sentence = scanReviewReason(row, { fieldLabel: ctx.fieldLabel }) ?? UNTRUSTED_DOUBT;
    return { eligibility: "needs-review", sentence, action: { kind: "review", label: ACTION_REVIEW, title: sentence }, destination: null, merge: null, ask: null };
  }
  const destination = scanDestination(row, ctx);
  const destLabel = destination?.label ?? "a table";
  // Whether this person may file into the table the row resolved to: asked
  // with the destination the resolver chose, not one the caller guessed at.
  const permitted = ctx.permittedFor?.(destination?.module ?? null);
  // The destination's app, when it is off here and no bundle offer covers it
  // (an offer installs the module with the bundle).
  const moduleOff = destination && !destination.installs ? ctx.moduleState?.(destination.module) : null;
  const meta = metaOf(row);
  const review = (sentence: string): ScanRowState => ({
    eligibility: "needs-review",
    sentence,
    action: { kind: "review", label: ACTION_REVIEW, title: sentence },
    destination,
    merge: null,
    ask: null,
  });
  const add = (): ScanRowState => ({
    eligibility: "ready",
    sentence: null,
    action: { kind: "add", label: ACTION_ADD, title: `File into ${destLabel}` },
    destination,
    merge: null,
    ask: null,
  });
  // Blocked is not a dead end: the row says what to ask for, and the
  // approval seam (#3073) turns the button into the ask.
  const blocked = (sentence: string): ScanRowState => {
    const ask: NonNullable<ScanRowState["ask"]> = [];
    if (destination?.installs && destination.bundle_external_id) ask.push({ kind: "install", key: destination.bundle_external_id });
    if (destination && moduleOff === "available") ask.push({ kind: "module", key: destination.module });
    const cap = createCapabilityForModule(destination?.module);
    if (cap && permitted === false) ask.push({ kind: "capability", key: cap });
    return { eligibility: "blocked", sentence, action: { kind: "blocked", label: ACTION_BLOCKED, title: sentence }, destination, merge: null, ask };
  };
  if (!isPending(row)) return add();
  // No grant makes a table in an app this deployment lacks: another table is
  // the only next step, for a person with or without the permission.
  if (permitted === false) return moduleOff === "absent" && destination ? review(fillSentence(UNAVAILABLE_SENTENCE, { table: destination.label })) : blocked(BLOCKED_SENTENCE);
  if (needsScanReview(withoutVouchedNameDoubt(row))) return review(scanReviewReason(row, { fieldLabel: ctx.fieldLabel }) ?? UNTRUSTED_DOUBT);
  if (!meta.reviewed) {
    // Another of a thing the workspace COUNTS is a re-purchase: +1 more, one
    // tap, the same on the card, the row and File N. A record with no count
    // (a set, a book, a machine) is one unique thing, and "+1" would double
    // it, so that match is a look first. The bulk sweep used to merge every
    // match while the card said Review for the same row (#3076).
    // The record it adds to is the destination's (scanMergeTarget), so the
    // pill, the button and the write name one table (#3707). A match the
    // person turned down is a new item like any other.
    const rebuy = scanRebuy(row, ctx);
    const updates = destination?.updates;
    if (rebuy.kind === "adds" && updates?.new_place) {
      const sentence = updates.held ? fillSentence(NEW_PLACE_SENTENCE, { title: updates.title, held: updates.held }) : NEW_PLACE_BARE_SENTENCE;
      return {
        eligibility: "ready",
        sentence,
        action: { kind: "merge", label: ACTION_ADD_PLACE, title: `Keeps these here as another place of ${updates.title} in ${destLabel}, the one you already have` },
        destination,
        merge: updates,
        ask: null,
      };
    }
    if (rebuy.kind === "adds" && updates) {
      return {
        eligibility: "ready",
        sentence: MERGE_SENTENCE,
        action: { kind: "merge", label: ACTION_MERGE, title: `Adds one more to ${updates.title} in ${destLabel}, the one you already have` },
        destination,
        merge: updates,
        ask: null,
      };
    }
    if (rebuy.kind === "hold") return review(rebuy.sentence);
    const top = scanTopCandidate(row);
    if (destination?.chosenBy !== "person" && (!top || top.basis === "keywords")) return review(KEYWORD_ROUTE_SENTENCE);
  }
  if (!destination) return review(KEYWORD_ROUTE_SENTENCE);
  // Nothing can make this table: the next step is another one.
  if (moduleOff === "absent") return review(fillSentence(UNAVAILABLE_SENTENCE, { table: destination.label }));
  if (destination.installs || moduleOff === "available") {
    // A person who may not install is blocked with an ask, not asked to
    // review: the review step cannot install either, and the ask can.
    if (ctx.canInstall === false) return blocked(fillSentence(INSTALL_BLOCKED_SENTENCE, { table: destination.label }));
    const sentence = fillSentence(INSTALL_SENTENCE, { table: destination.label });
    return { eligibility: "needs-install", sentence, action: { kind: "install-add", label: actionInstallAdd(destination.label), title: `${destination.label} is not set up yet; this turns it on and adds the item` }, destination, merge: null, ask: null };
  }
  return add();
}

/** The session's one action over its rows: what "File N" says and covers.
 *  Counts the rows the resolver calls ready or needs-install (an install is
 *  part of filing, said in the label), never a row that needs a person.
 *
 *  The context is not optional: a session is somebody's session, and what
 *  it offers depends on who is looking (a member's rows read Ask, and the
 *  strip must not count them). The page once called this with no context
 *  while the rows beside it had one, so the row said Ask an admin and the
 *  strip said Install & file 1 (#3122). */
export function scanSessionAction(
  rows: readonly ScanTriageRow[],
  ctx: ScanRowStateContext,
): { label: string | null; shortLabel: string | null; caption: string | null; ids: string[]; installs: number; reviews: number; merges: number; blocked: number; tables: string[]; off: string[] } {
  const ids: string[] = [];
  // Where the counted rows go, by the table's name, and which of those are
  // not turned on yet: the button says it (#4577), never "install".
  const tables: string[] = [];
  const off: string[] = [];
  let installs = 0;
  let reviews = 0;
  let merges = 0;
  // Rows waiting on an admin's yes, not on this person's look: the strip
  // says so rather than "needs review" over rows that have nothing to review.
  let blocked = 0;
  for (const r of rows) {
    const st = scanRowState(r, ctx);
    const id = (r as { id?: unknown }).id;
    if (st.eligibility === "ready" || st.eligibility === "needs-install") {
      if (typeof id === "string") ids.push(id);
      if (st.eligibility === "needs-install") installs++;
      if (st.action.kind === "merge") merges++;
      const dest = st.destination?.label;
      if (dest) {
        if (!tables.includes(dest)) tables.push(dest);
        if (st.eligibility === "needs-install" && !off.includes(dest)) off.push(dest);
      }
    } else if (st.eligibility === "needs-review") reviews++;
    else if (st.eligibility === "blocked") blocked++;
  }
  const n = ids.length;
  const label = n === 0 ? null : tables.length === 0 ? `Add ${n}` : sessionAddLabel(n, tables, off);
  // The phone spelling: the verb and the count, never the install word.
  //
  // The session row is ONE line at every width (#2982), and at 393px it is
  // out of room: the identity is the only thing on it allowed to truncate, so
  // every character the verb takes comes off the merchant's name. "Install &
  // file 1" cost about a third of it, and a fourteen-character shop read
  // "STITCH & S…" on the booth's own phone (#3393).
  //
  // The install is not lost, because it was never this label's fact to hold:
  // it belongs to a ROW's destination, and each row's own pill says it in
  // full ("Install & add", the table named, "not set up yet"), on screen
  // under the row a session opens by default. A session filing six rows into
  // three tables, one of them new, says "Install & file 6" here and means it
  // of one. The desk keeps the summary because it has the width to spare.
  const shortLabel = n === 0 ? null : `Add ${n}`;
  // What the label cannot hold, and the phone never sees a tooltip: the
  // caption is shown under the header (the place is added by the page).
  const caption = n === 0 ? null : sessionAddCaption(n, tables, off, null);
  return { label, shortLabel, caption, ids, installs, reviews, merges, blocked, tables, off };
}

/** The "More tools" fold, summarised from the same hints the tools come
 *  from (#3075): how many TOOLS sit behind it (the two box-state buttons
 *  are one tool), in the words of their relevance ("might apply" for
 *  possible, "unlikely" for no; the old label said "unlikely" for both),
 *  and the reason per tool. `folded` is what the surface put behind the
 *  fold (a phone folds possible and drops no; a desk folds both). */
export function scanToolsFold(
  hints: ScanToolHints | null | undefined,
  folded: readonly ScanTool[],
): { folded: ScanTool[]; label: string | null; reasons: Array<{ tool: ScanTool; reason: string }> } {
  const tools = [...new Set(folded)].filter((t) => SCAN_TOOLS.includes(t));
  if (!hints || tools.length === 0) return { folded: tools, label: null, reasons: [] };
  const might = tools.filter((t) => hints[t].relevance === "possible").length;
  const unlikely = tools.filter((t) => hints[t].relevance === "no").length;
  const parts: string[] = [];
  if (might) parts.push(`${might} ${might === 1 ? "tool" : "tools"} that might apply`);
  if (unlikely) parts.push(`${unlikely} unlikely for this one`);
  return {
    folded: tools,
    label: parts.length ? parts.join(", ") : null,
    reasons: tools.map((t) => ({ tool: t, reason: hints[t].reason })),
  };
}

/** The buttons behind the fold, by TOOL, each tool with its one reason
 *  (#3075): a tool with two buttons (the box states) is one group under one
 *  line, and a button's own words are its effect, never the reason again.
 *  A surface renders a group as the reason line, then its buttons. */
export function scanToolsFoldGroups<A extends { label: string; tool?: ScanTool; group?: string; folded?: string }>(
  hints: ScanToolHints | null | undefined,
  folded: readonly A[],
): Array<{ key: string; reason: string | null; actions: A[] }> {
  const fold = scanToolsFold(hints, folded.map((a) => a.tool).filter((t): t is ScanTool => !!t));
  const groups: Array<{ key: string; reason: string | null; actions: A[] }> = [];
  for (const a of folded) {
    const key = a.group ?? a.tool ?? a.label;
    const g = groups.find((x) => x.key === key);
    if (g) g.actions.push(a);
    else groups.push({ key, reason: fold.reasons.find((r) => r.tool === a.tool)?.reason ?? a.folded ?? null, actions: [a] });
  }
  return groups;
}

/** How long this capture has been sitting, in whole days. Null when it carries
 *  no usable timestamp — an unknown age must never read as "brand new". */
export function scanWaitingDays(row: ScanTriageRow, now: number = Date.now()): number | null {
  if (row.created_at == null) return null;
  const t = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
}

/** Pending for longer than the stale window. */
export function isScanStale(row: ScanTriageRow, now: number = Date.now()): boolean {
  if (!isPending(row)) return false;
  if (row.created_at == null) return false;
  const t = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  return !Number.isNaN(t) && now - t > STALE_MS;
}

/** Already has somewhere to go — a filing location or a container it was
 *  scanned into. The complement is what the put-away flow calls "unfiled". */
export function scanHasHome(row: ScanTriageRow): boolean {
  return !!row.target_location_id || !!row.target_container_id;
}

/** A person said "I'll photograph this myself" and has not yet. Unlike every
 *  other facet this one is a stated INTENT rather than a state the pipeline
 *  derived, which is exactly why it is here: the scanner and the dashboard both
 *  ask for it, and a predicate that lives in one of them is invisible to the
 *  other (and to whoever asks the assistant). */
export function wantsOwnPhoto(row: ScanTriageRow): boolean {
  return isPending(row) && metaOf(row).photo_wanted === true;
}

/**
 * Is this row held for a person: the card's own Review, whatever the reason
 * (no name, a doubtful read, a keyword-only or missing destination, a
 * duplicate that is not a re-purchase, a table this deployment lacks). The
 * ONE answer the To review filter, its count and the served `needs_review`
 * read, so a row the card flags is always in the filter and counted. They
 * used needsScanReview, which knows only the row's doubts, so a named row
 * whose destination was a keyword guess said Review on its card and was in
 * neither the filter nor the count (#3722).
 */
export function scanHeldForReview(row: ScanTriageRow, ctx: ScanRowStateContext = {}): boolean {
  return isPending(row) && scanRowState(row, ctx).eligibility === "needs-review";
}

/** The facets a caller can ask for. `all` is every pending item. */
export type ScanTriageFacet = "all" | "needs_review" | "waiting" | "unfiled" | "ready" | "photo_wanted";

export const SCAN_TRIAGE_FACETS: ScanTriageFacet[] = ["all", "needs_review", "waiting", "unfiled", "ready", "photo_wanted"];

/** Does this row belong to the facet? One switch, so a new facet is added in a
 *  single place and every surface gains it at once. */
export function matchesScanFacet(
  row: ScanTriageRow,
  facet: ScanTriageFacet,
  now: number = Date.now(),
  /** Who is asking, when known: a row whose table they cannot reach is not
   *  ready for them, whatever its home (#3610). */
  viewer?: ScanRowStateContext,
): boolean {
  switch (facet) {
    case "needs_review":
      return scanHeldForReview(row, viewer);
    case "waiting":
      return isScanStale(row, now);
    case "unfiled":
      return isPending(row) && !scanHasHome(row);
    case "ready":
      // Somewhere to go AND nothing left to ask — the "just put them away" set.
      return isPending(row) && scanHasHome(row) && !scanHeldForReview(row, viewer) && !(viewer && scanDestinationUnreachable(row, viewer));
    case "photo_wanted":
      return wantsOwnPhoto(row);
    case "all":
      return true;
  }
}

// ── A split piece that could not be cut out (#3614) ──────────────────────
//
// A split piece either gets its own crop or says it could not be cut, with
// the crop tool beside it. Two boxed sets split into two records that both
// carried the whole group photo (crop "none", no region) and said nothing,
// so each looked like it had its own picture. The reason is kept on the row
// (`crop_reason`); these are its words.

/** Why a piece of a split has no crop of its own. */
export type SplitUncutReason = "undecodable" | "box-too-small" | "box-too-large" | "flat" | "no-source" | "write-failed" | "not-boxed" | "detect-failed";

/** The reason in a person's words. */
export function splitUncutWords(reason: string | null | undefined): string {
  switch (reason) {
    case "undecodable": return "the photo could not be read";
    case "box-too-small": return "the region is too small to be a thing";
    case "box-too-large": return "the region is nearly the whole photo";
    case "flat": return "that region shows nothing";
    case "no-source": return "the photo is missing";
    case "write-failed": return "the crop could not be saved";
    case "detect-failed": return "the AI did not answer when asked where each thing is";
    default: return "the AI did not mark where this one is";
  }
}

/** A split piece still showing the whole group photo: the sentence it says
 *  and why, or null for anything else (a piece with its own crop, a row that
 *  is not a split piece). */
export function scanSplitUncut(row: ScanTriageRow): { sentence: string; why: string } | null {
  const meta = metaOf(row) as Record<string, unknown>;
  if (typeof meta.split_from !== "string" || !meta.split_from) return null;
  if (meta.crop === "ok") return null;
  const why = splitUncutWords(typeof meta.crop_reason === "string" ? meta.crop_reason : null);
  return { sentence: "Not cut out of the group photo, so it shows all of it.", why: `It could not be cut out: ${why}.` };
}
