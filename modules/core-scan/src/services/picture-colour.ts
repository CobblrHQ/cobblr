// What colour a picture actually is, from its pixels. No model.
//
// The word check (picture-agrees.ts) compares the item's words with a
// candidate's title and URL. A catalog picture whose URL is a bare hash
// ("/images/I/815YC-xkl3L.jpg") says nothing, so a beige skein was the
// picture of a dark-blue yarn whose label, fields and observation all said
// blue (#3729). The picture itself is the evidence: its dominant colour,
// read here, is judged against every colour the item states.
//
// Coarse on purpose. Families, not shades; the studio's white field is not
// the product; and a neutral (white, grey, silver, black) never contradicts
// anything, because a dark navy in a dim shot reads as black and a label
// reads as white.

import sharp from "sharp";

export type ColourFamily =
  | "white" | "black" | "grey" | "silver"
  | "red" | "pink" | "orange" | "yellow" | "gold"
  | "green" | "blue" | "purple" | "brown" | "beige";

/** The family a single colour belongs to. */
export function familyOfRgb(r: number, g: number, b: number): ColourFamily {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  if (l > 0.92) return "white";
  if (l < 0.1) return "black";
  if (s < 0.12) return l > 0.7 ? "white" : l < 0.22 ? "black" : "grey";
  if (h >= 15 && h < 50 && s < 0.6) return l > 0.6 ? "beige" : "brown";
  if (h < 15 || h >= 345) return l > 0.75 ? "pink" : "red";
  if (h < 40) return l < 0.35 ? "brown" : "orange";
  if (h < 65) return "yellow";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

/** A hex colour a field states ("#000080") as its family, or null. */
export function familyOfHex(hex: string): ColourFamily | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return familyOfRgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

/** The picture's dominant colour family and the share of the product's
 *  pixels it covers, the studio's white field left out. Null when the image
 *  cannot be read or nothing but background is left. */
export async function pictureColour(bytes: Uint8Array): Promise<{ family: ColourFamily; share: number } | null> {
  try {
    const { data, info } = await sharp(bytes).resize(48, 48, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const counts = new Map<ColourFamily, number>();
    let total = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const f = familyOfRgb(data[i]!, data[i + 1]!, data[i + 2]!);
      if (f === "white") continue; // the field the product stands in
      counts.set(f, (counts.get(f) ?? 0) + 1);
      total++;
    }
    if (total === 0) return null;
    let best: ColourFamily = "white";
    let n = 0;
    for (const [f, c] of counts) if (c > n) [best, n] = [f, c];
    return { family: best, share: Math.round((n / total) * 100) / 100 };
  } catch {
    return null;
  }
}

/** Colours that are one another's neighbours for this purpose: a beige skein
 *  called "tan" or "brown" is not a contradiction; a beige one called blue is. */
const GROUP: Record<ColourFamily, string> = {
  white: "neutral", black: "neutral", grey: "neutral", silver: "neutral",
  red: "red", pink: "red", orange: "orange", yellow: "yellow", gold: "earth",
  green: "green", blue: "blue", purple: "purple", brown: "earth", beige: "earth",
};

/** Does a picture of this dominant colour contradict an item stating these
 *  colours? Only a confident, non-neutral colour outside every stated
 *  colour's group does. The words it says so in, or null. */
export function colourContradiction(stated: ReadonlySet<string>, picture: { family: ColourFamily; share: number } | null | undefined): string | null {
  if (!picture || stated.size === 0 || picture.share < 0.35) return null;
  const g = GROUP[picture.family];
  if (g === "neutral") return null;
  const said = [...stated].map((s) => GROUP[s as ColourFamily] ?? s);
  if (said.includes(g)) return null;
  return `the picture is ${picture.family}, the item is ${[...stated].join("/")}`;
}

/** Does a picture of this dominant colour SHOW a colour the item states? The
 *  positive side of colourContradiction: not only "not the wrong colour" but
 *  the right one, so a blue skein gets a blue picture rather than the first
 *  one that says nothing (#3729). A neutral colour shows only itself (a white
 *  skein, a white picture); a hue shows its group (navy, blue, teal). */
export function colourShows(stated: ReadonlySet<string>, picture: { family: ColourFamily; share: number } | null | undefined): boolean {
  if (!picture || stated.size === 0 || picture.share < 0.35) return false;
  const g = GROUP[picture.family];
  if (g === "neutral") return stated.has(picture.family);
  return [...stated].some((s) => (GROUP[s as ColourFamily] ?? s) === g);
}

/** A picture's colours by share of its non-white pixels (the studio field is
 *  not the product), for comparing two pictures of what should be one thing. */
export type ColourShares = Partial<Record<ColourFamily, number>>;

export async function pictureColours(bytes: Uint8Array): Promise<ColourShares | null> {
  try {
    const { data, info } = await sharp(bytes).resize(48, 48, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const counts = new Map<ColourFamily, number>();
    let total = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const f = familyOfRgb(data[i]!, data[i + 1]!, data[i + 2]!);
      if (f === "white") continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
      total++;
    }
    if (total === 0) return null;
    const out: ColourShares = {};
    for (const [f, c] of counts) out[f] = Math.round((c / total) * 100) / 100;
    return out;
  } catch {
    return null;
  }
}

/** A hue this much of one picture, and next to none of the other, is a
 *  different-looking thing: a yellow handle on a lantern and none on a silver
 *  flashlight. Neutrals never decide it (a dark shot reads black, a label
 *  reads white), and a small accent in one and not the other does not either. */
const HUE_PRESENT = 0.15;
const HUE_ABSENT = 0.03;

/** Does a found picture look like a different thing from the item's own
 *  photo? The words it says so in, or null when nothing says they differ
 *  (which is not a proof that they match: it is colour, not shape). */
export function looksDifferent(own: ColourShares | null | undefined, picture: ColourShares | null | undefined): string | null {
  if (!own || !picture) return null;
  const byGroup = (s: ColourShares) => {
    const g = new Map<string, number>();
    for (const [f, v] of Object.entries(s)) {
      const group = GROUP[f as ColourFamily];
      if (!group || group === "neutral") continue;
      g.set(group, (g.get(group) ?? 0) + (v ?? 0));
    }
    return g;
  };
  const a = byGroup(own);
  const b = byGroup(picture);
  for (const group of new Set([...a.keys(), ...b.keys()])) {
    const inOwn = a.get(group) ?? 0;
    const inPicture = b.get(group) ?? 0;
    if (inPicture >= HUE_PRESENT && inOwn < HUE_ABSENT) return `the picture is largely ${group}, your photo has none`;
    if (inOwn >= HUE_PRESENT && inPicture < HUE_ABSENT) return `your photo is largely ${group}, the picture has none`;
  }
  return null;
}
