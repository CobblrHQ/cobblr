// The pieces a person listed for one photo, matched to where each sits
// (#6342). An assistant adding "printer 1 {details} and printer 2 {details}"
// from one picture says how many there are and what each is; the photo only
// has to say where. A box the caller gave is used as given. The rest come
// from the split's own detection, told the list, and are paired by name, then
// by order. When the photo shows a different number than was listed, nothing
// is guessed: the answer says what was seen, so the caller can ask.

import type { SplitBox, SplitItem } from "./image-ops.js";
import { similarity } from "./split-inherit.js";

export interface ListedPiece {
  name: string;
  /** Where it sits, in words ("left", "the black one"); a hint only. */
  where?: string | null;
  /** Where it sits, as fractions of the picture, when the caller knows. */
  box?: SplitBox | null;
}

export type Placed =
  | { ok: true; pieces: Array<{ box: SplitBox | null; boxed_as: string | null }>; uncut: boolean }
  | { ok: false; seen: string[] };

/** Does every listed piece carry its own box, so no detection is needed? */
export function allBoxed(listed: readonly ListedPiece[]): boolean {
  return listed.every((l) => !!l.box);
}

/** Pair the listed pieces with what detection boxed. `failed`: detection did
 *  not answer, so the pieces keep the group photo (uncut) rather than guess. */
export function placeListed(listed: readonly ListedPiece[], boxed: readonly SplitItem[], failed: boolean): Placed {
  if (allBoxed(listed)) return { ok: true, pieces: listed.map((l) => ({ box: l.box!, boxed_as: null })), uncut: false };
  if (failed) return { ok: true, pieces: listed.map((l) => ({ box: l.box ?? null, boxed_as: null })), uncut: true };
  if (boxed.length !== listed.length) return { ok: false, seen: boxed.map((b) => b.name) };
  const pairs: Array<number | null> = listed.map(() => null);
  const taken = new Set<number>();
  const scored: Array<{ l: number; b: number; s: number }> = [];
  listed.forEach((l, li) => boxed.forEach((b, bi) => scored.push({ l: li, b: bi, s: similarity(l.name, b.name) })));
  scored.sort((x, y) => y.s - x.s);
  for (const { l, b, s } of scored) {
    if (s < 0.25) break;
    if (pairs[l] !== null || taken.has(b)) continue;
    pairs[l] = b;
    taken.add(b);
  }
  // The rest by order: the model was asked to answer in the listed order.
  listed.forEach((_, li) => {
    if (pairs[li] !== null) return;
    const bi = boxed.findIndex((_, i) => !taken.has(i));
    pairs[li] = bi;
    taken.add(bi);
  });
  return {
    ok: true,
    uncut: false,
    pieces: listed.map((l, li) => (l.box ? { box: l.box, boxed_as: null } : { box: boxed[pairs[li]!]!.box, boxed_as: boxed[pairs[li]!]!.name })),
  };
}

/** What to say when the photo and the list disagree. */
export function countMismatchSentence(listed: readonly ListedPiece[], seen: readonly string[]): string {
  const n = seen.length;
  const saw = n === 0 ? "one thing" : n === 1 ? `1 thing (${seen[0]})` : `${n} things (${seen.join(", ")})`;
  return `I see ${saw} in the photo, and ${listed.length} were listed (${listed.map((l) => l.name).join(", ")}). Which is right? Nothing was added. Send the list again to match the photo, or give each piece a box.`;
}
