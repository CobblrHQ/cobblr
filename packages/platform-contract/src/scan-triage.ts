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
import {
  ACTION_ADD,
  ACTION_BLOCKED,
  ACTION_INSTALL_ADD,
  ACTION_MERGE,
  ACTION_REVIEW,
  BLOCKED_SENTENCE,
  DUPLICATE_SENTENCE,
  INSTALL_SENTENCE,
  KEYWORD_ROUTE_SENTENCE,
  LOW_CONFIDENCE_SENTENCE,
  MERGE_SENTENCE,
  NO_NAME_SENTENCE,
  SHORT_BARCODE_DOUBT,
  SPLIT_GROUP_DOUBT,
  SPLIT_SIBLINGS_DOUBT,
  STORE_CODE_NOTE,
  THROTTLED_SENTENCE,
  UNTRUSTED_DOUBT,
  fillSentence,
} from "@cobblr/platform-contract/scan-copy";
import { betterDestination, type DestinationTable } from "@cobblr/platform-contract/destination-label";
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
  /** The code that was scanned, when one was: a short one is what a
   *  low_trust flag on a barcode row is about (scanDoubt). */
  barcode_text?: string | null;
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
  const out = notes.replace(BAKED_DOUBT, "").replace(/\s{2,}/g, " ").trim();
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
  if (!isNamed(row)) return meta.code_type === "store-code" ? STORE_CODE_NOTE : NO_NAME_SENTENCE;
  if (meta.rate_limited) return THROTTLED_SENTENCE;
  // Said before the trust and confidence reasons: it names the exact value
  // to look at, where those only say "check it".
  const conflict = scanSourceConflict(row);
  if (conflict) return sourceConflictWords(conflict, opts.fieldLabel?.(conflict.field));
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
  // The identification itself. A doubt the pipeline raised says what it is
  // (a short barcode's card sentence, a split's own words); otherwise the
  // row's own sentence (a receipt line whose AI errored says so; a
  // percentage says nothing to do).
  const note = scanProvenanceNote(row.ai_notes);
  const doubt = scanDoubtWords(row);
  if (meta.rate_limited) out.push({ field: null, prompt: "Check the name", choices: [], because: "the lookup was throttled and has not answered yet" });
  else if (meta.split_review) out.push({ field: null, prompt: "Check the name", choices: [], because: "identified from the group photo, not its own crop" });
  else if (doubt) out.push({ field: null, prompt: "Check the name", choices: [], because: doubt });
  else if (note) out.push({ field: null, prompt: "Check the name", choices: [], because: note });
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
  if (!isPending(row)) return false;
  const e = scanRowState(row).eligibility;
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

export interface ScanDestinationContext {
  /** The workspace's routable tables (the menu), for a better table the
   *  workspace gained since the route was stored, and for a stored choice's
   *  label. */
  tables?: readonly (DestinationTable & { kind?: string | null; bundle_external_id?: string | null })[];
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
  };
  if (!isPending(row) || tables.length === 0) return system;
  const better = betterDestination(row.suggested_name ?? "", system.kind, tables, system.module);
  if (!better) return system;
  const entry = tables.find((t) => t.instance_name === better.instance_name);
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
  };
}

export interface ScanRowStateContext extends ScanDestinationContext {
  /** The person may file into this workspace (the capability). Default true. */
  permitted?: boolean;
  /** The person may install a bundle (the role). Default true. */
  canInstall?: boolean;
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
}
export function scanTrackedMatch(row: ScanTriageRow): ScanTrackedMatch | null {
  const m = ((row.suggested_metadata ?? {}) as {
    tracked_match?: { title?: unknown; matched_by?: unknown; kind?: unknown; id?: unknown; instance?: unknown; qty?: unknown } | null;
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
  };
}

/** What a merge files into: the tracked record, by the id the attach
 *  endpoint wants. */
export interface ScanMergeTarget {
  kind: string;
  id: string;
  instance: string | null;
  title: string;
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
  const destination = scanDestination(row, ctx);
  const destLabel = destination?.label ?? "a table";
  const meta = metaOf(row);
  const review = (sentence: string): ScanRowState => ({
    eligibility: "needs-review",
    sentence,
    action: { kind: "review", label: ACTION_REVIEW, title: sentence },
    destination,
    merge: null,
  });
  const add = (): ScanRowState => ({
    eligibility: "ready",
    sentence: null,
    action: { kind: "add", label: ACTION_ADD, title: `File into ${destLabel}` },
    destination,
    merge: null,
  });
  if (!isPending(row)) return add();
  if (ctx.permitted === false) {
    return { eligibility: "blocked", sentence: BLOCKED_SENTENCE, action: { kind: "blocked", label: ACTION_BLOCKED, title: BLOCKED_SENTENCE }, destination, merge: null };
  }
  if (needsScanReview(row)) return review(scanReviewReason(row, { fieldLabel: ctx.fieldLabel }) ?? UNTRUSTED_DOUBT);
  if (!meta.reviewed) {
    // Another of a thing the workspace COUNTS is a re-purchase: +1 more, one
    // tap, the same on the card, the row and File N. A record with no count
    // (a set, a book, a machine) is one unique thing, and "+1" would double
    // it, so that match is a look first. The bulk sweep used to merge every
    // match while the card said Review for the same row (#3076).
    const tracked = scanTrackedMatch(row);
    if (tracked) {
      if (tracked.counted && tracked.kind && tracked.id) {
        return {
          eligibility: "ready",
          sentence: MERGE_SENTENCE,
          action: { kind: "merge", label: ACTION_MERGE, title: `Adds one more to ${tracked.title}, the one you already have` },
          destination,
          merge: { kind: tracked.kind, id: tracked.id, instance: tracked.instance, title: tracked.title },
        };
      }
      return review(DUPLICATE_SENTENCE);
    }
    const top = scanTopCandidate(row);
    if (destination?.chosenBy !== "person" && (!top || top.basis === "keywords")) return review(KEYWORD_ROUTE_SENTENCE);
  }
  if (!destination) return review(KEYWORD_ROUTE_SENTENCE);
  if (destination.installs) {
    const sentence = fillSentence(INSTALL_SENTENCE, { table: destination.label });
    if (ctx.canInstall === false) return review(sentence);
    return { eligibility: "needs-install", sentence, action: { kind: "install-add", label: ACTION_INSTALL_ADD, title: `${destination.label} is not set up yet; this installs it and files the item` }, destination, merge: null };
  }
  return add();
}

/** The session's one action over its rows: what "File N" says and covers.
 *  Counts the rows the resolver calls ready or needs-install (an install is
 *  part of filing, said in the label), never a row that needs a person. */
export function scanSessionAction(
  rows: readonly ScanTriageRow[],
  ctx: ScanRowStateContext = {},
): { label: string | null; ids: string[]; installs: number; reviews: number; merges: number } {
  const ids: string[] = [];
  let installs = 0;
  let reviews = 0;
  let merges = 0;
  for (const r of rows) {
    const st = scanRowState(r, ctx);
    const id = (r as { id?: unknown }).id;
    if (st.eligibility === "ready" || st.eligibility === "needs-install") {
      if (typeof id === "string") ids.push(id);
      if (st.eligibility === "needs-install") installs++;
      if (st.action.kind === "merge") merges++;
    } else if (st.eligibility === "needs-review") reviews++;
  }
  const n = ids.length;
  const label = n === 0 ? null : installs > 0 ? `Install & file ${n}` : `File ${n}`;
  return { label, ids, installs, reviews, merges };
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
