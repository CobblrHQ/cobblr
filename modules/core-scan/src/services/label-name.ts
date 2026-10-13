// The name a label prints, read with no model (#6100).
//
// A photo read sometimes answers with a description of the picture instead of
// a name ("ground spice jar with red cap ... held by a hand ..."), which is
// never a name (nameReadsAsProse). The jar's label says GROUND CUMIN in the
// biggest type on it. So the name is taken from the label: the tallest
// product-like line the OCR engine reads, with the lines of the same size
// beside it, in reading order. Never a guess: when no line stands out, there
// is no name, and the row asks the person for one.

import { ocrWordBoxes, type OcrWord } from "./ocr.js";

export interface LabelLine {
  text: string;
  /** The median height of the line's words, in pixels. */
  height: number;
  top: number;
  /** The mean confidence of the line's words, 0 to 100. */
  conf: number;
}

/** Print every label carries that is never what the thing is called. */
const SMALL_PRINT =
  /\b(store|keep|cool|dry|place|refrigerate|net|wt|weight|ingredients?|best|before|use|by|exp|lot|batch|www|http|made|product|produced|distributed|packed|contains|allergens?|serving|nutrition|calories|kcal|per|oz|ml|kg|lb)\b/i;

/** A title has to stand out: its type at least this much taller than the
 *  label's typical line. A page of same-sized text has no title to take. */
const STANDS_OUT = 1.25;
const MIN_CONF = 60;
const MAX_WORDS = 6;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/** The engine's words, as its lines. */
export function linesOfWords(words: readonly OcrWord[]): LabelLine[] {
  const byLine = new Map<string, OcrWord[]>();
  for (const w of words) {
    const key = `${w.block}.${w.par}.${w.line}`;
    byLine.set(key, [...(byLine.get(key) ?? []), w]);
  }
  return [...byLine.values()].map((ws) => {
    const sorted = [...ws].sort((a, b) => a.left - b.left);
    return {
      text: sorted.map((w) => w.text).join(" "),
      height: median(sorted.map((w) => w.height)),
      top: Math.min(...sorted.map((w) => w.top)),
      conf: sorted.reduce((n, w) => n + w.conf, 0) / sorted.length,
    };
  });
}

function productLike(l: LabelLine): boolean {
  const letters = (l.text.match(/\p{L}/gu) ?? []).length;
  const visible = l.text.replace(/\s/g, "").length;
  return (
    letters >= 3 &&
    letters / Math.max(1, visible) >= 0.8 &&
    l.conf >= MIN_CONF &&
    !SMALL_PRINT.test(l.text) &&
    l.text.split(/\s+/).length <= MAX_WORDS
  );
}

function titleCase(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}&'\- ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === w.toUpperCase() ? w[0]! + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** The label's name from its lines, or null when no product-like line
 *  stands out. */
export function labelNameFrom(lines: readonly LabelLine[]): string | null {
  return labelReadFrom(lines)?.name ?? null;
}

/** The label's name and how far its title stands out from the rest of the
 *  label (the tallest line over the typical one): with several photos of a
 *  thing, the one whose title stands out most is the front. */
export function labelReadFrom(lines: readonly LabelLine[]): { name: string; standout: number } | null {
  const candidates = lines.filter(productLike);
  if (!candidates.length) return null;
  const tallest = candidates.reduce((a, b) => (b.height > a.height ? b : a));
  // The typical line is the label's small print: a title set over two lines
  // is half the lines on a sparse label, and would otherwise be its own median.
  const smaller = lines.filter((l) => l.height < 0.75 * tallest.height).map((l) => l.height);
  const typical = smaller.length ? median(smaller) : median(lines.map((l) => l.height));
  if (tallest.height < STANDS_OUT * typical) return null;
  // The lines set in the same type as the tallest, next to it: "GROUND" over
  // "CUMIN" is one name in two lines.
  const same = candidates.filter((l) => l.height >= 0.75 * tallest.height).sort((a, b) => a.top - b.top);
  const at = same.indexOf(tallest);
  let from = at;
  let to = at;
  const near = (a: LabelLine, b: LabelLine) => Math.abs(a.top - b.top) <= 2.2 * tallest.height;
  while (from > 0 && near(same[from - 1]!, same[from]!)) from--;
  while (to < same.length - 1 && near(same[to]!, same[to + 1]!)) to++;
  const words = same
    .slice(from, to + 1)
    .map((l) => l.text)
    .join(" ")
    .split(/\s+/)
    .slice(0, MAX_WORDS)
    .join(" ");
  const name = titleCase(words);
  return isRealName(name) ? { name, standout: tallest.height / Math.max(1, typical) } : null;
}

/** A name has a word of four letters or more: a logo's initials or a cut-off
 *  fragment ("Uni", read off the owner's cumin) is no product's name. */
function isRealName(name: string): boolean {
  return name.split(/\s+/).some((w) => (w.match(/\p{L}/gu) ?? []).length >= 4);
}

const contentWords = (s: string) => new Set((s.toLowerCase().match(/\p{L}{4,}/gu) ?? []));

/** Does a label's name agree with what the photo read said about the thing
 *  (its description, its category)? A name sharing no word with it is a
 *  line the OCR found, not the thing the read saw (#6100). With nothing said,
 *  there is nothing to disagree with. */
export function labelAgrees(name: string, said: readonly (string | null | undefined)[]): boolean {
  const heard = new Set<string>();
  for (const s of said) if (s) for (const w of contentWords(s)) heard.add(w);
  if (!heard.size) return true;
  for (const w of contentWords(name)) if (heard.has(w)) return true;
  return false;
}

/** The name printed on a photographed label, or null when there is no OCR
 *  engine or no line stands out as one. */
export async function nameFromLabelPhoto(bytes: Buffer | Uint8Array): Promise<string | null> {
  return (await labelReadOfPhoto(bytes))?.name ?? null;
}

export async function labelReadOfPhoto(bytes: Buffer | Uint8Array): Promise<{ name: string; standout: number } | null> {
  const words = await ocrWordBoxes(bytes);
  return words && words.length ? labelReadFrom(linesOfWords(words)) : null;
}

/** The name the person's photos of a thing print, read from each: the one
 *  whose title stands out most (a side shot's small print loses to the
 *  front), or null when none prints one (#6100). */
export async function labelNameAcross(
  fileIds: readonly string[],
  read: (fileId: string) => Promise<{ name: string; standout: number } | null>,
): Promise<string | null> {
  let best: { name: string; standout: number } | null = null;
  for (const id of fileIds) {
    const got = await read(id).catch(() => null);
    if (got && (!best || got.standout > best.standout)) best = got;
  }
  return best?.name ?? null;
}
