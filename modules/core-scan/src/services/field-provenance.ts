// What a model's fields may say about a thing, given what was actually seen.
//
// A photo of four balls of yarn was split into four children; each child's
// own routing turn, looking at the same picture, filled Vendor "Amazon" and
// "Local yarn shop", and gave the two balls named Signature 4 Ply two
// different weights, 3 DK and 4 Aran, beside an Add button (#2970). Nothing
// in the picture says where it was bought, and one picture cannot say two
// weights for one product: those values were invented, and the router's
// note beside them read as the record of a fact.
//
// Two rules, applied where the model's fields are adopted, after it answers
// and before anything is stored (the seam the receipt facts and the split
// inheritance already use):
//
//   1. Field provenance. Where, when and for how much a thing was BOUGHT
//      (the purchase fields named in the platform contract) comes only from
//      purchase evidence: a receipt or order session, or a person's own
//      words on the capture. A photo identify, a split, a barcode or web
//      lookup has none, and a purchase field on their candidates is
//      stripped. The router's note stays; identity fields (weight, colour,
//      fibre, size) may come from a photo.
//
//   2. Siblings agree or nobody does. Children of one split that share a
//      name are one product seen in one picture; when the model gives them
//      different values for an identity field, at least one is invented
//      and there is no telling which, so the field is blank on all of them
//      and the row says why. Never a coin flip.

import { isPurchaseField } from "@cobblr/platform-contract/receipt-fact-names";
import {
  acquisitionSourceConflict,
  fieldProvenanceOf,
  isAcquiredFromField,
  isSellerField,
  purchaseEvidenceOf,
  purchaseFieldRole,
  type FieldProvenanceMap,
} from "@cobblr/platform-contract/acquisition-source";

export interface EvidenceRow {
  source_kind?: string | null;
  suggested_metadata?: Record<string, unknown> | null;
}

/** Does this capture carry evidence of a purchase: a receipt or order
 *  session, or the person's own words? */
export function hasPurchaseEvidence(row: EvidenceRow): boolean {
  const meta = row.suggested_metadata ?? {};
  if (meta.source === "receipt" || meta.source === "email") return true;
  if (meta.receipt_group_id || meta.purchases_order_id || meta.receipt_vendor || meta.receipt_order_id) return true;
  // A typed capture or a hint is a person saying so; their words are evidence.
  if (row.source_kind === "note" || row.source_kind === "text") return true;
  if (typeof meta.user_hint === "string" && meta.user_hint.trim()) return true;
  return false;
}

interface CandidateLike {
  fields?: Record<string, unknown>;
}

/**
 * Strip the purchase fields a candidate carries when the capture holds no
 * purchase evidence. Mutates in place. Returns the names it removed (with
 * the values, for the log), empty when nothing was.
 */
export function stripUnsupportedPurchaseFields(row: EvidenceRow, candidates: CandidateLike[]): string[] {
  if (hasPurchaseEvidence(row)) return [];
  const removed: string[] = [];
  for (const cand of candidates) {
    const fields = cand.fields;
    if (!fields) continue;
    for (const name of Object.keys(fields)) {
      if (!isPurchaseField(name)) continue;
      const v = fields[name];
      if (v === null || v === undefined || v === "") continue;
      removed.push(`${name}=${String(v)}`);
      delete fields[name];
    }
  }
  return removed;
}

export interface SiblingRow {
  id: string;
  suggested_name: string | null;
  suggested_candidates: unknown;
  suggested_metadata?: Record<string, unknown> | null;
}

const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const valueKey = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : JSON.stringify(v));

/** A stored candidate list as an array. jsonb reaches us parsed under `pg`,
 *  but a JSON.stringify'd write read straight back can arrive as a string;
 *  a string read as "no candidates" would hide every disagreement. */
function candidateList(raw: unknown): Array<{ fields?: Record<string, unknown> }> {
  if (Array.isArray(raw)) return raw as Array<{ fields?: Record<string, unknown> }>;
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

/** The top candidate's fields of a stored candidate list, or {}. */
function topFields(candidates: unknown): Record<string, unknown> {
  return candidateList(candidates)[0]?.fields ?? {};
}

/** Fields each piece reads off its own crop, not off the product: two balls
 *  of one yarn are two colourways, two dye lots. The twin rule leaves these
 *  alone; everything else on a product is one fact for both twins. */
export const PER_UNIT_FIELD_NAMES = /^(colou?r|colou?rway|shade|dye_lot|lot|batch|serial(?:_number)?|remaining|length_remaining|condition|notes?)$/;

/**
 * Which identity fields this row and its same-named siblings disagree on.
 * The model saw the same balls and answered once, so a twin field is kept
 * only when every routed twin carries the same value: two values, or a
 * value beside a blank, is the same contradiction (a twin with no
 * candidates yet has not answered and does not count). Per-unit fields
 * are each piece's own. Fields already found in disagreement on any of
 * them (`split_disagreed`) stay disagreed, so a re-run of one child cannot
 * quietly fill what the other was blanked for.
 */
export function siblingDisagreements(
  mine: { suggested_name: string | null; candidates: CandidateLike[]; suggested_metadata?: Record<string, unknown> | null },
  siblings: SiblingRow[],
): string[] {
  const out = new Set<string>();
  const prior = (m: Record<string, unknown> | null | undefined) =>
    Array.isArray(m?.split_disagreed) ? (m!.split_disagreed as unknown[]).filter((k): k is string => typeof k === "string") : [];
  for (const k of prior(mine.suggested_metadata)) out.add(k);
  const my = mine.candidates[0]?.fields ?? {};
  const filled = (v: unknown) => v !== null && v !== undefined && v !== "";
  for (const sib of siblings) {
    if (!sameName(mine.suggested_name, sib.suggested_name)) continue;
    for (const k of prior(sib.suggested_metadata)) out.add(k);
    const list = candidateList(sib.suggested_candidates);
    if (!list.length) continue; // not routed yet: no answer to disagree with
    const theirs = list[0]?.fields ?? {};
    for (const k of new Set([...Object.keys(my), ...Object.keys(theirs)])) {
      if (PER_UNIT_FIELD_NAMES.test(k)) continue;
      const v = my[k];
      const t = theirs[k];
      if (!filled(v) && !filled(t)) continue;
      if (!filled(v) || !filled(t) || valueKey(v) !== valueKey(t)) out.add(k);
    }
  }
  return [...out].sort();
}

/** Blank the named fields on every candidate. Mutates; returns how many
 *  values it removed. */
export function blankFields(candidates: CandidateLike[], names: readonly string[]): number {
  let n = 0;
  for (const cand of candidates) {
    if (!cand.fields) continue;
    for (const k of names) {
      if (k in cand.fields) {
        delete cand.fields[k];
        n++;
      }
    }
  }
  return n;
}

/** Field names as a person reads them: "weight_class" is "weight class". */
const humanField = (k: string): string => k.replace(/_/g, " ");

/** The sentence a child carries when the photo gave its twins two answers. */
export function siblingReviewWords(fields: readonly string[]): string {
  if (!fields.length) return "";
  const list = fields.map(humanField);
  const named = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `One photo, two answers for ${named} on these pieces. Choose ${list.length === 1 ? "it" : "them"} yourself.`;
}

// ── Who put a value there, kept across every re-run (#3008) ──────────────
//
// A person's answer for a field of a pending row lives in user_fields
// (services/user-fields.ts) and is merged over the top route on every read,
// so no pass here touches it; its `person` stamp is what the passes and the
// confirm read to keep their hands off.

import { userFieldsOf } from "./user-fields.js";

/** A menu field as the stamping needs it. */
interface RoledFieldLike {
  name: string;
  field_role?: string | null;
}

/**
 * The stamps to persist after a match: the person's, kept as they were; the
 * evidence stamps the receipt pass returned; and an `inference` stamp on any
 * purchase-source field the top route filled that nothing else vouches for.
 * A field the route no longer fills loses its non-person stamp, so the map
 * says what stands, not what once did.
 */
export function provenanceStamps(opts: {
  meta: Record<string, unknown> | null | undefined;
  candidates: CandidateLike[];
  evidence: FieldProvenanceMap;
  /** The top route's table fields, for the roles; names decide otherwise. */
  tableFields?: readonly RoledFieldLike[];
  /** The top route's fields as stored BEFORE this match: a guess the
   *  evidence displaced on an earlier run, or one this run's router did not
   *  repeat, stays on the record as `replaced` rather than vanishing. */
  priorFields?: Record<string, unknown> | null;
}): FieldProvenanceMap {
  const prior = fieldProvenanceOf(opts.meta);
  const person = userFieldsOf(opts.meta)?.values ?? {};
  const evidence = purchaseEvidenceOf(opts.meta);
  const out: FieldProvenanceMap = {};
  for (const [name, stamp] of Object.entries(prior)) {
    if (stamp.by === "person" && name in person) out[name] = stamp;
  }
  const top = opts.candidates[0]?.fields;
  const byName = new Map((opts.tableFields ?? []).map((f) => [f.name, f]));
  for (const [name, stamp] of Object.entries(opts.evidence)) {
    if (out[name]) continue;
    const was = opts.priorFields?.[name];
    const f = byName.get(name) ?? { name };
    const displaced =
      stamp.replaced ??
      prior[name]?.replaced ??
      (was !== null && was !== undefined && String(was).trim() !== "" && isAcquiredFromField(f) && acquisitionSourceConflict(name, was, evidence)
        ? String(was)
        : undefined);
    out[name] = displaced ? { ...stamp, replaced: displaced } : stamp;
  }
  if (!top) return out;
  for (const [name, value] of Object.entries(top)) {
    if (out[name] || value === null || value === undefined || value === "") continue;
    const f = byName.get(name) ?? { name };
    const role = purchaseFieldRole(f);
    if (!role || !(isAcquiredFromField(f) || isSellerField(f))) continue;
    // Nothing vouched for it: a model or a rule put it there. Said so.
    out[name] = { by: "inference", from: "router", role };
  }
  return out;
}
