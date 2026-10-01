// Does a picture the web handed back show the thing it is offered for?
//
// The ranking (catalogScore) orders a pool; it never says no, so the best of a
// bad pool still won. Three "Custom Sheet Metal Printer" records, brand
// "Custom Sheet Metal", each got the same marketing banner for sheet-metal
// fabrication: a headline, a welding torch, a cabinet, and no printer. Every
// word it shared with the record was the maker's name.
//
// So a picture is put on a record only when its own words agree with what the
// record IS, and the maker's name is not what it is:
//   • a banner or a graphic is never a product photo (shape, or what it says
//     it is: a logo, an infographic, a company's services page);
//   • the record's head noun ("printer", "spool", "drill"), or its model
//     number when the name is only a maker and a model, has to be in what the
//     picture is called;
//   • the brand's words count for nothing either way.
// Not sure means no: a record with no picture is better than one with a wrong
// picture, which reads as the platform saying something false about it.
// Heuristics only; the AI pick, when somebody asks for one, chooses among the
// pictures that pass.

import type { DdgImageResult } from "./ddg-images.js";
import { isColorWord } from "./ddg-images.js";

export interface ThingToPicture {
  /** The record's name, as the person wrote it. */
  name: string;
  /** Its maker, when the record says. Never evidence the picture is right. */
  brand?: string | null;
}

export type PictureVerdict = { ok: true } | { ok: false; reason: string };

const FILLER = new Set(["a", "an", "the", "and", "with", "for", "of", "in", "on", "by", "to", "new", "set", "pack", "pcs", "pc", "kit", "x"]);
/** Words that carry a digit but describe a kind of thing, not one model. */
const DESCRIPTORS = new Set(["2d", "3d", "4k", "8k", "4g", "5g", "hd", "uhd"]);
/** A quantity or a size: "100g", "17in", "2", "1.75mm". Says nothing about what. */
const MEASURE = /^\d+([.,]\d+)?(mm|cm|m|in|inch|ft|g|kg|mg|ml|l|oz|lb|lbs|w|v|mah|pcs|pc|pack|ct)?$/;
/** What a picture says it is when it is not a photo of a product. */
const GRAPHIC = /\b(banners?|headers?|logos?|infographics?|brochures?|flyers?|collages?|clip ?art|illustrations?|vectors?|icons?|wallpapers?|templates?|diagrams?|charts?|screenshots?|services|solutions|manufacturing|fabrication|capabilities|company|industries|ai[- ]generated|renders?|mock-?ups?)\b/;

const tokens = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What the picture is called: its title, and the file name in its address,
 *  which on a library or a shop is often the only honest label it has. */
function pictureWords(r: DdgImageResult): string[] {
  let file = "";
  try {
    file = decoded(new URL(r.url).pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  } catch {
    /* not a URL: the title alone */
  }
  return tokens(`${r.title ?? ""} ${file}`);
}

/** The words that say what the record is: its name without the maker's words,
 *  colours, sizes and filler. The head noun is the last of them ("Printer" in
 *  "Custom Sheet Metal Printer Black"); a model number is kept apart. */
export function whatItIs(item: ThingToPicture): { head: string | null; models: string[] } {
  const brand = new Set(tokens(item.brand ?? ""));
  const words = tokens(item.name).filter((w) => !brand.has(w) && !FILLER.has(w) && !isColorWord(w) && !MEASURE.test(w));
  const models = words.filter((w) => /\d/.test(w) && /[a-z]/.test(w) && !DESCRIPTORS.has(w));
  const nouns = words.filter((w) => !/\d/.test(w) && w.length >= 3);
  return { head: nouns[nouns.length - 1] ?? null, models };
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** One word naming the same thing: the word, its plural, or a spelling one
 *  letter off ("whiskey"/"whisky") once the word is long enough to be sure. */
function sameWord(want: string, have: string): boolean {
  if (want === have) return true;
  const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
  if (stem(want) === stem(have)) return true;
  return want.length >= 6 && editDistanceAtMostOne(want, have);
}

export function showsTheThing(r: DdgImageResult, item: ThingToPicture): PictureVerdict {
  if (r.width && r.height) {
    const ar = r.width / r.height;
    if (ar > 2 || ar < 0.4) return { ok: false, reason: "a banner, not a photo of one thing" };
  }
  const own = new Set([...tokens(item.name), ...tokens(item.brand ?? "")]);
  const graphic = (r.title ?? "").toLowerCase().match(GRAPHIC)?.[0];
  if (graphic && !tokens(graphic).some((w) => own.has(w))) return { ok: false, reason: `says it is ${graphic}, not the thing` };

  const { head, models } = whatItIs(item);
  const words = pictureWords(r);
  const joined = words.join(" ");
  if (models.some((m) => joined.includes(m))) return { ok: true };
  if (head && words.some((w) => sameWord(head, w))) return { ok: true };
  if (!head && !models.length) return { ok: false, reason: "the name says only who made it, not what it is" };
  return { ok: false, reason: `never says ${head ?? models[0]}` };
}

/** The picture to suggest for a record: the best-ranked one that shows it, or
 *  none. `items` arrives ranked; the first that passes wins. */
export function pickPhotoOf(items: readonly DdgImageResult[], item: ThingToPicture): DdgImageResult | null {
  return items.find((r) => r.url && showsTheThing(r, item).ok) ?? null;
}

/** A strip a person chooses from keeps every picture (they may know better),
 *  but the ones that show the record come first, in their ranked order. */
export function showingFirst<T extends DdgImageResult>(items: readonly T[], item: ThingToPicture): T[] {
  const shows = items.filter((r) => showsTheThing(r, item).ok);
  return [...shows, ...items.filter((r) => !shows.includes(r))];
}
