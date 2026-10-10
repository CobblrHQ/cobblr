// A field's provenance is a LIST of contributions, not one value (#4583).
//
// "Zero Carbon Tea" came from the barcode catalog; "Pumpkin Spiced Chai" from
// the label in a second photo. One `{by, from}` stamp could name only one of
// them, so the headline said one thing and Source data another. Each
// contribution is `{source, value, photo?}`; the resolved value keeps its
// contributors, the headline shows the decisive one, Source data lists them
// all, and they cannot disagree because both are read from this list.
//
// Additive: a stamp with no list reads as a one-entry list (its `from`), so no
// row needs rewriting.

import type { FieldProvenance } from "@cobblr/platform-contract/acquisition-source";

export interface FieldContribution {
  /** Who supplied it: "catalog", "label", "ai", "receipt", "person"... Words a
   *  person can read, as `FieldProvenance.from`. */
  source: string;
  /** What it said, when it had a value of its own. */
  value?: string;
  /** Which photo it was read from, as the person knows it ("photo 2"). */
  photo?: string;
  at?: string;
}

/** Ranking of what decides the headline: a person's word, then what was read
 *  off the item, then a catalog's answer, then the AI's say-so. */
const RANK: Record<string, number> = { person: 0, label: 1, receipt: 1, order: 1, "order-email": 1, decode: 1, catalog: 2, ai: 3, router: 3 };
const rankOf = (source: string): number => RANK[source] ?? 3;

type Stamped = Pick<FieldProvenance, "by" | "from"> & { contributions?: FieldContribution[] };

/** The contributions a stamp carries; a stamp without a list reads as one. */
export function contributionsOf(stamp: Stamped | null | undefined): FieldContribution[] {
  if (!stamp) return [];
  if (Array.isArray(stamp.contributions) && stamp.contributions.length > 0) return stamp.contributions;
  const source = stamp.by === "person" ? "person" : stamp.from ?? (stamp.by === "inference" ? "ai" : "evidence");
  return [{ source }];
}

/** The contribution that decides the headline: the best-ranked, the latest of a
 *  tie. */
export function decisiveContribution(list: readonly FieldContribution[]): FieldContribution | null {
  let best: FieldContribution | null = null;
  for (const c of list) if (!best || rankOf(c.source) <= rankOf(best.source)) best = c;
  return best;
}

const SOURCE_WORDS: Record<string, string> = {
  catalog: "the barcode catalog",
  label: "the label",
  ai: "the AI",
  receipt: "the receipt",
  order: "the order",
  "order-email": "the order email",
  person: "you",
  decode: "the code",
  router: "the AI",
};
const sourceWords = (s: string): string => SOURCE_WORDS[s] ?? s;

/** The headline: what decided the value, in plain words ("Name read from the
 *  label in photo 2"). Null when nothing is known. */
export function provenanceHeadline(field: string, stamp: Stamped | null | undefined): string | null {
  const c = decisiveContribution(contributionsOf(stamp));
  if (!c) return null;
  const f = field.charAt(0).toUpperCase() + field.slice(1);
  const where = c.photo ? ` in ${c.photo}` : "";
  if (c.source === "person") return `${f} set by you`;
  if (c.source === "ai") return `${f} said by the AI, not read off the item`;
  return `${f} read from ${sourceWords(c.source)}${where}`;
}

/** Source data: every contribution, one line each, the same words as the
 *  headline's. */
export function provenanceLines(stamp: Stamped | null | undefined): string[] {
  return contributionsOf(stamp).map((c) => {
    const where = c.photo ? ` (${c.photo})` : "";
    return `${sourceWords(c.source).replace(/^./, (x) => x.toUpperCase())}${where}${c.value ? `: ${c.value}` : ""}`;
  });
}

/** Add a contribution to a stamp, replacing the same source's earlier one (a
 *  re-read of the same photo is not a second voice). Pure. */
export function withContribution<T extends Stamped>(stamp: T, c: FieldContribution): T & { contributions: FieldContribution[] } {
  const rest = contributionsOf(stamp).filter((x) => !(x.source === c.source && x.photo === c.photo));
  return { ...stamp, contributions: [...rest, c] };
}
