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
import { STORE_CODE_NOTE } from "@cobblr/platform-contract/scan-copy";

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
}

function metaOf(row: ScanTriageRow): TriageMeta {
  return (row.suggested_metadata ?? {}) as TriageMeta;
}

function isPending(row: ScanTriageRow): boolean {
  return row.status === "pending";
}

function isNamed(row: ScanTriageRow): boolean {
  return !!row.suggested_name?.trim();
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
export function needsScanReview(row: ScanTriageRow): boolean {
  if (!isPending(row)) return false;
  const meta = metaOf(row);
  if (meta.reviewed) return false;
  const confidence = row.ai_confidence == null ? null : Number(row.ai_confidence);
  return (
    !isNamed(row) ||
    !!meta.low_trust ||
    !!meta.rate_limited ||
    (confidence != null && !Number.isNaN(confidence) && confidence < SCAN_REVIEW_CONFIDENCE) ||
    scanSourceConflict(row) !== null
  );
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
  if (!isNamed(row)) return meta.code_type === "store-code" ? STORE_CODE_NOTE : "No name yet.";
  if (meta.rate_limited) return "The lookup was throttled and has not answered yet.";
  // Said before the trust and confidence reasons: it names the exact value
  // to look at, where those only say "check it".
  const conflict = scanSourceConflict(row);
  if (conflict) return sourceConflictWords(conflict, opts.fieldLabel?.(conflict.field));
  if (meta.low_trust) {
    const note = row.ai_notes?.trim();
    if (note) return note;
    if (meta.split_review) return "Identified from the group photo, not its own crop. Check it.";
    if (meta.split_disagreed?.length) return "The pieces split from one photo disagree on what this is.";
    return "The identification is not trusted. Check it.";
  }
  const confidence = Number(row.ai_confidence);
  return `Identified at ${Math.round(confidence * 100)}% confidence.`;
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
  if (!isNamed(row)) {
    out.push({ field: null, prompt: "Name it", choices: [], because: "nothing could name this" });
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
  // The identification itself. The row's own sentence first (a receipt
  // line whose AI errored says so; a percentage says nothing to do).
  const note = row.ai_notes?.trim();
  if (meta.rate_limited) out.push({ field: null, prompt: "Check the name", choices: [], because: "the lookup was throttled and has not answered yet" });
  else if (meta.split_review) out.push({ field: null, prompt: "Check the name", choices: [], because: "identified from the group photo, not its own crop" });
  else if (note) out.push({ field: null, prompt: "Check the name", choices: [], because: note });
  else if (meta.low_trust) out.push({ field: null, prompt: "Check the name", choices: [], because: "the identification is not trusted" });
  else {
    const confidence = Number(row.ai_confidence);
    out.push({ field: null, prompt: "Check the name", choices: [], because: `identified at ${Math.round(confidence * 100)}% confidence` });
  }
  return out;
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
export function isScanReadyToFile(row: ScanTriageRow): boolean {
  if (!isPending(row) || !isNamed(row)) return false;
  const top = scanTopCandidate(row);
  if (!top || top.basis === "keywords") return false;
  return !needsScanReview(row);
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

/** The facets a caller can ask for. `all` is every pending item. */
export type ScanTriageFacet = "all" | "needs_review" | "waiting" | "unfiled" | "ready" | "photo_wanted";

export const SCAN_TRIAGE_FACETS: ScanTriageFacet[] = ["all", "needs_review", "waiting", "unfiled", "ready", "photo_wanted"];

/** Does this row belong to the facet? One switch, so a new facet is added in a
 *  single place and every surface gains it at once. */
export function matchesScanFacet(
  row: ScanTriageRow,
  facet: ScanTriageFacet,
  now: number = Date.now(),
): boolean {
  switch (facet) {
    case "needs_review":
      return needsScanReview(row);
    case "waiting":
      return isScanStale(row, now);
    case "unfiled":
      return isPending(row) && !scanHasHome(row);
    case "ready":
      // Somewhere to go AND nothing left to ask — the "just put them away" set.
      return isPending(row) && scanHasHome(row) && !needsScanReview(row);
    case "photo_wanted":
      return wantsOwnPhoto(row);
    case "all":
      return true;
  }
}
