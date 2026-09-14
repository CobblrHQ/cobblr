// A fact the NAME states is not the model's to guess.
//
// A ball of yarn labelled "Signature 4 Ply" was routed with weight "4 –
// Aran" (#2970, reopened). "4 ply" IS the weight: the UK ply scale is a
// fixed table (1 and 2 ply lace, 3 ply light fingering, 4 ply fingering,
// DK, aran, chunky, super chunky) and so are the words "DK", "aran",
// "chunky", "lace" when a name carries them. Code plans, the model
// narrates: a weight the name states is derived here, deterministically,
// and a model value that contradicts it is dropped, with the note saying
// what the label said.
//
// Generic on purpose: the rule is keyed by what a table's field OFFERS, not
// by the field's name. Any text field whose choices read as the Craft Yarn
// Council scale (Lace, Fingering, Sport, DK, Worsted, Aran, Bulky, Super
// Bulky, three or more of them) is a weight field, however the workspace
// named it; a table with no such field is untouched.

import type { ScanMenuEntry } from "./matchmaker.js";

/** The scale's categories, in the Craft Yarn Council's words. */
export type WeightCategory = "lace" | "fingering" | "sport" | "dk" | "worsted" | "aran" | "bulky" | "super bulky";

/** What a name or label may say, by category. Tested first to last, so
 *  "super chunky" is read before "chunky". A name that says two different
 *  categories is left alone. */
const WEIGHT_WORDS: Array<[WeightCategory, RegExp]> = [
  ["super bulky", /\b(super[\s-]*(?:bulky|chunky)|jumbo|1[46][\s-]*ply)\b/i],
  ["lace", /\b(lace(?:weight)?|cobweb|[12][\s-]*ply)\b/i],
  ["fingering", /\b(fingering|sock(?:\s*yarn)?|super[\s-]*fine|superfine|[34][\s-]*ply|4[\s-]*f[äa]dig|4[\s-]*fach)\b/i],
  ["sport", /\b(sport(?:weight)?|5[\s-]*ply)\b/i],
  ["dk", /\b(dk|double[\s-]*knit(?:ting)?|8[\s-]*ply|light[\s-]*worsted)\b/i],
  ["worsted", /\b(worsted|10[\s-]*ply|afghan)\b/i],
  ["aran", /\b(aran)\b/i],
  ["bulky", /\b(bulky|chunky|12[\s-]*ply)\b/i],
];

/** The weight a name states, and the words that state it; null when the
 *  name says nothing or says two things. */
export function weightFromName(name: string | null | undefined): { category: WeightCategory; said: string } | null {
  if (!name) return null;
  const hits: Array<{ category: WeightCategory; said: string }> = [];
  let rest = name;
  for (const [category, re] of WEIGHT_WORDS) {
    const m = rest.match(re);
    if (!m) continue;
    hits.push({ category, said: m[1] ?? m[0] });
    // "super chunky" must not also read as "chunky".
    rest = rest.replace(re, " ");
  }
  const categories = new Set(hits.map((h) => h.category));
  if (categories.size !== 1) return null;
  return hits[0]!;
}

/** Does this field's choice list read as the weight scale? */
export function looksLikeWeightScale(choices: readonly string[] | undefined): boolean {
  if (!choices?.length) return false;
  const words = ["lace", "fingering", "sport", "dk", "worsted", "aran", "bulky", "chunky"];
  const hit = new Set<string>();
  for (const c of choices) for (const w of words) if (new RegExp(`\\b${w}\\b`, "i").test(c)) hit.add(w);
  return hit.size >= 3;
}

/** The choice that names the category, or null when the table offers none
 *  for it ("bulky" never picks "Super Bulky"). */
export function choiceForWeight(category: WeightCategory, choices: readonly string[]): string | null {
  const word = category === "super bulky" ? /\bsuper[\s-]*(bulky|chunky)\b/i : category === "bulky" ? /\b(bulky|chunky)\b/i : new RegExp(`\\b${category}\\b`, "i");
  const hits = choices.filter((c) => word.test(c) && (category === "super bulky" || !/\bsuper\b/i.test(c)));
  return hits[0] ?? null;
}

export interface NameFact {
  field: string;
  value: string;
  said: string;
  /** What the model had put there, when it contradicted the name. */
  was: string | null;
}

interface CandidateLike {
  kind?: string;
  instance?: string | null;
  module?: string;
  fields?: Record<string, unknown>;
}

function entryFor(cand: CandidateLike, menu: readonly ScanMenuEntry[]): ScanMenuEntry | undefined {
  return (
    menu.find((e) => e.module === cand.module && (e.instance ?? null) === (cand.instance ?? null)) ??
    menu.find((e) => e.kind === cand.kind)
  );
}

/**
 * After the model: on every candidate whose table offers a weight scale,
 * the weight the item's name states. Overwrites a model value that
 * contradicts it; fills a blank. Mutates in place; returns what it set, for
 * the note and the record. A name with no weight word changes nothing.
 */
export function applyNameFacts(name: string | null | undefined, candidates: CandidateLike[], menu: readonly ScanMenuEntry[]): NameFact[] {
  const stated = weightFromName(name);
  if (!stated) return [];
  const out: NameFact[] = [];
  for (const cand of candidates) {
    const entry = entryFor(cand, menu);
    if (!entry) continue;
    for (const f of entry.fields) {
      if (!looksLikeWeightScale(f.choices)) continue;
      const value = choiceForWeight(stated.category, f.choices!);
      if (!value) continue;
      const fields = (cand.fields ??= {});
      const had = fields[f.name];
      const was = typeof had === "string" && had.trim() && had.trim().toLowerCase() !== value.toLowerCase() ? had.trim() : null;
      fields[f.name] = value;
      if (!out.some((o) => o.field === f.name)) out.push({ field: f.name, value, said: stated.said, was });
    }
  }
  return out;
}

/** The sentence the card carries: what the name said, and what was dropped. */
export function nameFactWords(facts: readonly NameFact[]): string {
  return facts
    .map((f) => {
      const label = f.field.replace(/_/g, " ");
      return f.was
        ? `${label[0]!.toUpperCase()}${label.slice(1)} "${f.value}" from the name ("${f.said}"); the AI said "${f.was}".`
        : `${label[0]!.toUpperCase()}${label.slice(1)} "${f.value}" from the name ("${f.said}").`;
    })
    .join(" ");
}
