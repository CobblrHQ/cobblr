// Combining two inbox items that are the same thing — done as a UNION, not a
// pick-one.
//
// The scanner can see the same object two ways and produce two entries: a VIN
// decode gives the year/trim/identity but no colour; a photo of the same vehicle
// gives the colour and plate but no VIN. Combine used to keep ONE item's fields
// and discard the other's, so the merge LOST half of what was learned — the
// reported "it made a separate vehicle and the colours/plate didn't carry over".
//
// So: keep the richest item as the base, and fill its gaps from the others. Pure
// + tested; the endpoint just persists the result.

import { isMachineReadCode } from "./barcode-source.js";

export interface CombineCandidate {
  module: string;
  instance: string | null;
  kind: string;
  fields: Record<string, string | number | boolean>;
  [k: string]: unknown;
}

export interface CombineItem {
  id: string;
  barcode_text: string | null;
  image_file_id: string | null;
  suggested_metadata: Record<string, unknown> | null;
  suggested_candidates: CombineCandidate[] | null;
}

const src = (it: CombineItem): string =>
  String((it.suggested_metadata as { source?: string } | null)?.source ?? "");

/** How authoritative an item's identity is — a real scan/decode beats a photo. */
function identityRank(it: CombineItem): number {
  const s = src(it);
  if (s.startsWith("decoder:")) return 3; // VIN/etc — ground truth
  if (
    it.barcode_text &&
    !isMachineReadCode((it.suggested_metadata as { barcode_source?: string } | null)?.barcode_source)
  )
    return 2; // a real scanned barcode
  if (s === "vision" || s === "photo") return 1; // read off a picture
  return 0;
}

/** The field count of an item's top candidate — a tiebreak on richness. */
function fieldCount(it: CombineItem): number {
  return Object.keys(it.suggested_candidates?.[0]?.fields ?? {}).length;
}

/**
 * Which item to KEEP by default when the user didn't pin one. The most
 * authoritative identity (a VIN decode over a photo), then the one carrying the
 * most fields. So combining a plate photo into a VIN-decoded vehicle keeps the
 * vehicle (year/trim/VIN) and treats the photo as the thing being folded in.
 */
export function pickPrimaryId(items: CombineItem[], keepId?: string | null): string | null {
  if (keepId && items.some((i) => i.id === keepId)) return keepId;
  const best = [...items].sort(
    (a, b) => identityRank(b) - identityRank(a) || fieldCount(b) - fieldCount(a),
  )[0];
  return best?.id ?? null;
}

/**
 * The primary's candidates, with its TOP candidate's fields filled from the other
 * items — but only from an item that routes to the SAME table (a vehicle's colour
 * doesn't belong on a book). The primary's own values always win; the others only
 * fill GAPS. Returns the primary's candidates untouched when it has none.
 */
/** A kind whose DECLARED traits include `unique` is tracked one-by-one — a
 *  vehicle, a machine, an asset. Reads the kind's trait map (axis → trait
 *  value(s)), never the kind's name. */
export function traitsHaveUnique(traits: Record<string, unknown> | null | undefined): boolean {
  if (!traits) return false;
  return Object.values(traits).some((v) =>
    Array.isArray(v) ? v.includes("unique") : v === "unique",
  );
}

/** The combined row's quantity. Units SUM for fungible stock (four scans of the
 *  same soap → ×4), but a unique-tracked thing captured twice — a VIN scan plus
 *  a plate photo of the SAME vehicle — is still ONE thing: keep the largest
 *  single count instead of summing sightings into phantom units. */
export function combinedQuantity(quantities: number[], unique: boolean): number {
  const qs = quantities.map((q) => (Number.isFinite(q) && q > 0 ? q : 1));
  if (qs.length === 0) return 1;
  return unique ? Math.max(...qs) : qs.reduce((a, b) => a + b, 0);
}

export function unionCandidateFields(
  primary: CombineItem,
  others: CombineItem[],
): CombineCandidate[] | null {
  const cands = primary.suggested_candidates;
  const top = cands?.[0];
  if (!cands || !top) return cands ?? null;

  const merged: Record<string, string | number | boolean> = { ...top.fields };
  const sameTable = (c: CombineCandidate | undefined): boolean =>
    !!c && c.module === top.module && (c.instance ?? null) === (top.instance ?? null);

  for (const o of others) {
    const oc = o.suggested_candidates?.[0];
    if (!sameTable(oc)) continue;
    for (const [k, v] of Object.entries(oc!.fields)) {
      if (k in merged) continue; // the primary already has it — it wins
      if (v === "" || v === null || v === undefined) continue;
      merged[k] = v;
    }
  }
  return [{ ...top, fields: merged }, ...cands.slice(1)];
}
