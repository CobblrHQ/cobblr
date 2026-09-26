// A resale listing's title is not the item's name. A catalog that learned a
// code from a marketplace listing answers with the seller's wording: "Lot of
// 2 Loops & Threads Charisma 109 yds / 3.5 oz ~ Dark Blue & White" for one
// dark blue skein. The lot is the seller's bundle, not what is on the table,
// and the second colour is the other skein in it. Pure; the quantity is never
// taken from here (the person's count or a label read sets it).

import { statedLooks } from "./picture-agrees.js";

const LOT = /^\s*(?:\(?\s*lot\s+of\s+\d{1,3}\s*\)?|\d{1,3}\s*(?:x|pc|pcs)\s)\s*[-:,~]?\s*/i;
const LOT_ANYWHERE = /\s*\(\s*lot\s+of\s+\d{1,3}\s*\)\s*/gi;
const SHADE = new Set(["dark", "light", "pale", "deep", "bright", "royal", "sky", "baby", "hot", "soft", "off"]);

function colourPhraseAtEnd(words: string[]): number {
  // How many trailing words form a colour phrase: a colour, and the shade
  // words in front of it.
  let n = 0;
  const last = words[words.length - 1];
  if (!last || statedLooks(last).colours.size === 0) return 0;
  n = 1;
  while (n < words.length && SHADE.has(words[words.length - 1 - n]!.toLowerCase())) n++;
  return n;
}

function isColourPhrase(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && colourPhraseAtEnd(words) === words.length;
}

/** The item's name out of a listing title. `stated` is a colour the item is
 *  already known to be (a colourway, a label read); of a pair of colours the
 *  one that agrees with it is kept, else the first. */
export function cleanListingTitle(title: string, stated?: string | null): string {
  // Only a lot listing's colour pair is two items: "Oreo Black & White" is
  // one product whose name says two colours.
  const lot = LOT.test(title) || /\(\s*lot\s+of\s+\d/i.test(title);
  let t = title.replace(LOT, "").replace(LOT_ANYWHERE, " ");
  const amp = lot ? t.lastIndexOf(" & ") : -1;
  if (amp > 0) {
    const left = t.slice(0, amp);
    const right = t.slice(amp + 3).replace(/[\s.,;:]+$/, "");
    const leftWords = left.trim().split(/\s+/);
    const k = colourPhraseAtEnd(leftWords);
    if (k > 0 && isColourPhrase(right)) {
      const first = leftWords.slice(-k).join(" ");
      const want = statedLooks(stated ?? "").colours;
      const agrees = (phrase: string) => [...statedLooks(phrase).colours].some((c) => want.has(c));
      const keep = want.size && agrees(right) && !agrees(first) ? right : first;
      t = [...leftWords.slice(0, -k), keep].join(" ");
    }
  }
  return t
    .replace(/\s*~\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
