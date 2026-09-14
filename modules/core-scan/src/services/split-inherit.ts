// What a split's children take from the group photo, and what the second
// model call is allowed to add.
//
// A photo of two sealed boxed sets was read perfectly on the first pass: the
// observation named both sets with their set numbers, the candidate carried
// set_number, lifecycle "sealed" and the theme. The split then asked the
// model AGAIN for names and boxes, took THAT name (no numbers), cut each
// child from the wrong part of the frame, and re-identified the black crop:
// the model, seeing nothing, "inferred set details from the title" and wrote
// lifecycle "built" on a sealed box (#2945).
//
// Heuristic-first says the opposite order. The parent's evidence is the
// child's identity; the second call adds boxes only. A field arrives from
// evidence or not at all: a parent value is inherited by a piece when the
// piece's own name carries it, or when the group observation states it and no
// sibling's name claims it. And a child's later look at its own crop can add,
// never subtract: an observation that says the crop shows nothing is not a
// reason to forget what the group photo knew.

import type { ScanMenuEntry } from "./matchmaker.js";
import type { BoxScale, SplitBox, SplitItem } from "./image-ops.js";

export interface Individual {
  name: string;
  brand: string | null;
  qty: number;
}

/** One child-to-be: what it is called, where it sits, what named it. */
export interface SplitPiece {
  name: string;
  brand: string | null;
  qty: number;
  box: SplitBox | null;
  /** The scale the model wrote the box in, for the record. */
  box_scale?: BoxScale;
  /** The observation entry this piece is, when the group read named it. */
  observed: Individual | null;
  /** What segmentation called it, kept for the record when the observed name won. */
  boxed_as: string | null;
}

/** What a child carries from its parent, stored as `split_inherited`. */
export interface SplitInherited {
  from: string;
  name: string;
  brand: string | null;
  fields: Record<string, string | number | boolean>;
  /** The group observation's sentence(s) about this piece, or null. */
  observation: string | null;
  /** Which of the parent's whole-photo keys (series, category, entity_type)
   *  this piece kept, and what corroborated each: its own name, the
   *  sentence about it, or a fact the group observation states. Absent on
   *  a child split before the judgement existed. */
  meta_kept?: Partial<Record<InheritedMetaKey, InheritedMetaWhy>>;
}

/** The parent's whole-photo keys the split used to copy onto every piece
 *  verbatim: the vision's series for the frame landed on a Holiday frame
 *  beside a Wicked set, and the inbox then said both were Wicked (#3013). */
export type InheritedMetaKey = "series" | "category" | "entity_type";
export const INHERITED_META_KEYS: readonly InheritedMetaKey[] = ["series", "category", "entity_type"];
export type InheritedMetaWhy = "name" | "observation" | "group";

export interface InheritedMeta {
  /** The keys this piece keeps, with the values. */
  kept: Partial<Record<InheritedMetaKey, string>>;
  /** What corroborated each kept key. */
  why: Partial<Record<InheritedMetaKey, InheritedMetaWhy>>;
  /** The keys this piece does not keep, with the parent's values: kept on
   *  the child as `split_dropped` so nothing is lost, only not claimed. */
  dropped: Partial<Record<InheritedMetaKey, string>>;
}

const STOP = new Set(["the", "and", "with", "set", "sets", "box", "boxed", "building", "kit", "pack", "item", "items", "edition", "limited", "retail"]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  // A number both carry is the strongest tie there is.
  const numA = a.match(/\d{4,}/g) ?? [];
  const numB = new Set(b.match(/\d{4,}/g) ?? []);
  const number = numA.some((n) => numB.has(n)) ? 1 : 0;
  return shared / Math.max(ta.size, tb.size) + number;
}

/**
 * Pair what segmentation boxed with what the observation pass named. The
 * observed name wins wherever both exist (it was read from the whole picture,
 * numbers and all); a box only says where. Greedy one-to-one by similarity,
 * then by order when the counts agree; an observed item nobody boxed still
 * becomes a piece (it keeps the group shot), and a boxed item nobody observed
 * keeps segmentation's name.
 */
export function pairPieces(boxed: SplitItem[], observed: Individual[]): SplitPiece[] {
  if (boxed.length < 2) {
    return observed.map((o) => ({ name: o.name, brand: o.brand, qty: o.qty, box: null, observed: o, boxed_as: null }));
  }
  const taken = new Set<number>();
  const pairs: Array<Individual | null> = boxed.map(() => null);
  const scored: Array<{ b: number; o: number; s: number }> = [];
  boxed.forEach((b, bi) => observed.forEach((o, oi) => scored.push({ b: bi, o: oi, s: similarity(b.name, o.name) })));
  scored.sort((x, y) => y.s - x.s);
  for (const { b, o, s } of scored) {
    if (s < 0.25) break;
    if (pairs[b] || taken.has(o)) continue;
    pairs[b] = observed[o]!;
    taken.add(o);
  }
  if (boxed.length === observed.length) {
    // Same count, some names that did not resolve: the lists are in the same
    // order often enough (top to bottom, left to right) that order is the
    // last word, once the confident matches are placed.
    boxed.forEach((_, bi) => {
      if (pairs[bi]) return;
      const oi = observed.findIndex((_, i) => !taken.has(i));
      if (oi >= 0) {
        pairs[bi] = observed[oi]!;
        taken.add(oi);
      }
    });
  }
  const out: SplitPiece[] = boxed.map((b, bi) => {
    const o = pairs[bi];
    return o
      ? { name: o.name, brand: o.brand ?? b.brand, qty: o.qty, box: b.box, box_scale: b.box_scale, observed: o, boxed_as: b.name }
      : { name: b.name, brand: b.brand, qty: b.qty, box: b.box, box_scale: b.box_scale, observed: null, boxed_as: b.name };
  });
  observed.forEach((o, oi) => {
    if (!taken.has(oi)) out.push({ name: o.name, brand: o.brand, qty: o.qty, box: null, observed: o, boxed_as: null });
  });
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const mentions = (text: string, value: string): boolean => {
  const v = norm(value);
  if (!v) return false;
  return new RegExp(`(?:^|\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(norm(text));
};

/**
 * The parent's candidate fields that name THIS piece. A number (a set
 * number, a model number) is inherited only when the piece's own name carries
 * it. A word is inherited when the piece's name carries it; when a sibling's
 * name carries it instead, it is the sibling's; when no name carries it but
 * the group observation states it ("two sealed boxes"), it is a fact about
 * the group and every piece inherits it. Anything else is not evidence.
 */
export function inheritedFields(
  piece: { name: string },
  siblings: string[],
  parentFields: Record<string, unknown> | null | undefined,
  observation: string | null,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(parentFields ?? {})) {
    if (raw === null || raw === undefined || typeof raw === "boolean") continue;
    if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim()))) {
      const digits = String(raw).trim();
      if (new RegExp(`(?:^|\\D)${digits}(?:\\D|$)`).test(piece.name)) out[key] = raw as string | number;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (mentions(piece.name, raw)) {
      out[key] = raw;
      continue;
    }
    if (siblings.some((s) => mentions(s, raw))) continue;
    if (observation && mentions(observation, raw)) out[key] = raw;
  }
  return out;
}

/**
 * Which of the parent's whole-photo keys THIS piece may claim. A series is
 * a fact about one thing: the piece keeps it only when its own name or the
 * sentence about it names the series ("Brickwright Wicked 75684" does,
 * "Holiday Picture Frame 40702" does not), never because the group photo
 * as a whole was read as that series. A category or a noun hint is kept
 * when the piece's name or its own sentence carries it, or when the group
 * observation states it. In every case a value a sibling's name carries is
 * the sibling's and not this piece's (the same rule as inheritedFields).
 * Anything else is a guess about the group and is not the piece's.
 */
export function inheritedMeta(
  piece: { name: string },
  siblings: string[],
  parentMeta: Partial<Record<InheritedMetaKey, unknown>> | null | undefined,
  ownObservation: string | null,
  groupObservation: string | null,
): InheritedMeta {
  const out: InheritedMeta = { kept: {}, why: {}, dropped: {} };
  for (const key of INHERITED_META_KEYS) {
    const raw = parentMeta?.[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    let why: InheritedMetaWhy | null = null;
    if (mentions(piece.name, value)) why = "name";
    // A sibling whose name carries it owns it: one sentence can describe
    // both boxes, and "the top box is Wicked" in the frame's sentence is
    // about the set, not the frame.
    else if (siblings.some((s) => mentions(s, value))) why = null;
    else if (ownObservation && mentions(ownObservation, value)) why = "observation";
    else if (key !== "series" && groupObservation && mentions(groupObservation, value)) why = "group";
    if (why) {
      out.kept[key] = value;
      out.why[key] = why;
    } else {
      out.dropped[key] = value;
    }
  }
  return out;
}

/** The sentences of the group observation about this piece: those that
 *  carry a token of its name no sibling's name carries. Null when none does. */
export function observationFor(piece: { name: string }, siblings: string[], observation: string | null): string | null {
  if (!observation?.trim()) return null;
  const sib = new Set(siblings.flatMap((s) => tokens(s)));
  const own = tokens(piece.name).filter((t) => !sib.has(t));
  if (!own.length) return null;
  const sentences = observation.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const hits = sentences.filter((s) => own.some((t) => mentions(s, t)));
  return hits.length ? hits.join(" ") : null;
}

/** The observation pass could not see the picture: a crop of a shadow, a
 *  patch of table, a frame that came out black. */
export function unreadableObservation(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(entirely|completely|almost entirely|mostly|very)?\s*(dark|black|blank|featureless|obscured|blurry|blurred)\b.*\b(image|photo|picture|frame|crop)\b|\b(image|photo|picture|frame|crop)\b.*\b(entirely|completely|almost entirely|mostly)\s+(dark|black|blank|featureless|obscured|blurry|blurred)\b|\bno (discernible|identifiable|visible) (object|item|thing|content|detail)s?\b|\bnothing (is )?(visible|discernible|identifiable)\b|\bcannot (be )?(seen|made out|identif)/i.test(
    text,
  );
}

export interface SplitInheritedMeta {
  split_inherited?: SplitInherited | null;
}

interface CandidateLike {
  kind?: string;
  instance?: string | null;
  module?: string;
  fields?: Record<string, unknown>;
}

/** The menu entry a candidate routes to. The table (module + instance) first:
 *  two instances of one module share a kind, and the fields are the table's. */
function entryFor(cand: CandidateLike, menu: readonly ScanMenuEntry[]): ScanMenuEntry | undefined {
  return (
    menu.find((e) => e.module === cand.module && (e.instance ?? null) === (cand.instance ?? null)) ??
    menu.find((e) => e.kind === cand.kind)
  );
}

/**
 * After the model: what the group photo established about this piece wins
 * on every candidate whose table declares the field. Mutates in place, like
 * the receipt facts beside it. A no-op for anything that is not a split child.
 */
export function applySplitInheritance(
  meta: SplitInheritedMeta | null | undefined,
  candidates: CandidateLike[],
  menu: readonly ScanMenuEntry[],
): number {
  const inherited = meta?.split_inherited?.fields;
  if (!inherited || !Object.keys(inherited).length) return 0;
  let written = 0;
  for (const cand of candidates) {
    const entry = entryFor(cand, menu);
    if (!entry) continue;
    const fields = (cand.fields ??= {});
    for (const f of entry.fields) {
      if (!(f.name in inherited)) continue;
      const v = inherited[f.name]!;
      if (fields[f.name] !== v) written++;
      fields[f.name] = v;
    }
  }
  return written;
}

/** The sentence a child's card carries when its identity is the group
 *  photo's rather than its own crop's. */
export function splitReviewWords(review: "crop-failed" | "crop-unreadable" | null): string {
  switch (review) {
    case "crop-failed":
      return "Identified from the group photo: its crop could not be cut. Check it.";
    case "crop-unreadable":
      return "Identified from the group photo: its crop could not be read. Check it.";
    default:
      return "";
  }
}
