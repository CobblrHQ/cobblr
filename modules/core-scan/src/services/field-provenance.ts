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

/**
 * Which identity fields this row and its same-named siblings disagree on:
 * a key both filled, with different values. Fields already found in
 * disagreement on any of them (`split_disagreed`) stay disagreed, so a
 * re-run of one child cannot quietly fill what the other was blanked for.
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
  for (const sib of siblings) {
    if (!sameName(mine.suggested_name, sib.suggested_name)) continue;
    for (const k of prior(sib.suggested_metadata)) out.add(k);
    const theirs = topFields(sib.suggested_candidates);
    for (const [k, v] of Object.entries(my)) {
      if (v === null || v === undefined || v === "") continue;
      const t = theirs[k];
      if (t === null || t === undefined || t === "") continue;
      if (valueKey(v) !== valueKey(t)) out.add(k);
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
  return `The photo gives two answers for ${named} on the pieces with this name, so ${list.length === 1 ? "it is" : "they are"} left for you to choose.`;
}
