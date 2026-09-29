// One way a colour lands, whatever brought it: a hand-picked swatch
// ("#00A36C"), a tag's RGBA ("ff8800ff", OpenTag3D), a short hex ("#0af"),
// "rgb(0, 163, 108)", or a plain word ("Yellow"). Every surface that draws a
// swatch, and every writer that stores a colour, reads it through here, so
// two spools of the same colour look the same whichever door they came in by.
// A colourway name that is not a colour ("Sunset", "Banana Rama") stays a
// name: no swatch is better than a wrong one.

/** The basic colour words, as their usual swatch. Deliberately short: a word
 *  a person would write on a label, not every CSS name. */
const WORDS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  grey: "#808080",
  gray: "#808080",
  silver: "#c0c0c0",
  red: "#ff0000",
  orange: "#ffa500",
  yellow: "#ffff00",
  gold: "#ffd700",
  green: "#008000",
  lime: "#00ff00",
  teal: "#008080",
  cyan: "#00ffff",
  blue: "#0000ff",
  navy: "#000080",
  purple: "#800080",
  violet: "#ee82ee",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  natural: "#f5f0e1",
};

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** `#rrggbb` (lower case) for anything that names a colour, else null. */
export function normalizeColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  let m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  // A short hex only with its "#": bare, "fed" and "ace" are words.
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(v);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(v);
  if (m) return `#${hex2(+m[1]!)}${hex2(+m[2]!)}${hex2(+m[3]!)}`;
  return WORDS[v] ?? null;
}

/** How a colour is STORED: a hex spelling (any length, a tag's RGBA, rgb())
 *  becomes `#rrggbb`; anything else, a colour word or a colourway name
 *  ("Royal Blue", "Sunset"), is kept as written. A colour field that is a
 *  type's key keeps matching the names it already holds; only two spellings
 *  of one hex become one. */
export function canonicalColour(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim();
  if (!v || /^[a-z\s]+$/i.test(v)) return value;
  return normalizeColour(v) ?? value;
}

/** The colour a thing's NAME says, when its colour field is empty: the last
 *  colour word in it ("…Banana Rama …, Yellow" is yellow). Null when none. */
export function colourFromName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const hit = WORDS[words[i]!];
    if (hit) return hit;
  }
  return null;
}

/** The last colour word in a name, capitalised ("…, Yellow" → "Yellow"). */
export function colourWordFromName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const words = name.split(/[^A-Za-z]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!.toLowerCase();
    if (WORDS[w]) return w[0]!.toUpperCase() + w.slice(1);
  }
  return null;
}

const MATERIALS: Array<[RegExp, string]> = [
  [/\bpet-?g\b/i, "PETG"],
  [/\bpla\+|\bpla plus\b/i, "PLA+"],
  [/\bpla\b/i, "PLA"],
  [/\basa\b/i, "ASA"],
  [/\babs\b/i, "ABS"],
  [/\btpu\b/i, "TPU"],
  [/\bnylon\b|\bpa(?:6|12)?\b/i, "Nylon"],
  [/\bpolycarbonate\b|\bpc\b/i, "PC"],
  [/\bpva\b/i, "PVA"],
];

/** What a filament's product name says about the fields a type is keyed on,
 *  for a record whose fields came in empty (a scan that read only the name):
 *  "Cookiecad Silk PLA …, 1.75mm 1kg" is PLA, 1.75 mm. Only what the name
 *  plainly states; never a guess past it. */
export function filamentFieldsFromName(name: unknown): { material?: string; diameter?: string; color?: string } {
  if (typeof name !== "string") return {};
  const out: { material?: string; diameter?: string; color?: string } = {};
  for (const [re, m] of MATERIALS) {
    if (re.test(name)) {
      out.material = m;
      break;
    }
  }
  const d = /\b(1\.75|2\.85|3(?:\.0)?)\s*mm\b/i.exec(name);
  if (d) out.diameter = `${d[1] === "3" || d[1] === "3.0" ? "2.85" : d[1]} mm`;
  // As a WORD, the way a scan stores a colour name: the swatch draws it,
  // and a key field keeps holding names.
  const word = colourWordFromName(name);
  if (word) out.color = word;
  return out;
}

// ── More than one colour (gradient and multi-colour filament, variegated yarn)
//
// A colour value that is several colours is still ONE string, so it lives in
// the same text field, round-trips through export and import, and compares as
// a key: `gradient(#ee0979, #ff6a00)` blends along the length, `multi(#c0c0c0,
// #ffd700)` is hard segments (dual- and tri-colour silk). 2 to 4 colours, the
// same count a tag's color_1..color_4 carries. A single colour is unchanged.

export type ColourStyle = "solid" | "gradient" | "multi";
export interface ColourSpec {
  style: ColourStyle;
  /** `#rrggbb`, in order; one for solid, 2 to 4 otherwise. */
  colours: string[];
}

export const MAX_COLOURS = 4;

/** Colourways whose name IS a well-known run of colours. Only names that mean
 *  the same thing from any maker. */
const COLOURWAYS: Record<string, ColourSpec> = {
  rainbow: { style: "gradient", colours: ["#e40303", "#ffed00", "#008026", "#004dff"] },
};

/** What a stored colour value shows, or null when it names no colour. */
export function parseColour(value: unknown): ColourSpec | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const m = /^(gradient|multi)\(\s*(.+)\s*\)$/i.exec(v);
  if (m) {
    const colours = m[2]!.split(",").map((p) => normalizeColour(p)).filter((c): c is string => !!c).slice(0, MAX_COLOURS);
    if (colours.length >= 2) return { style: m[1]!.toLowerCase() as ColourStyle, colours };
    return colours.length === 1 ? { style: "solid", colours } : null;
  }
  const one = normalizeColour(v);
  if (one) return { style: "solid", colours: [one] };
  return COLOURWAYS[v.toLowerCase()] ?? null;
}

/** The stored form of a spec: a single colour as its hex, several as
 *  `gradient(...)` or `multi(...)`. */
export function formatColour(spec: ColourSpec): string {
  const cs = spec.colours.map((c) => normalizeColour(c) ?? c).slice(0, MAX_COLOURS);
  if (cs.length <= 1 || spec.style === "solid") return cs[0] ?? "";
  return `${spec.style}(${cs.join(", ")})`;
}

/** The CSS background that draws a spec: a fill, a blend, or hard segments. */
export function colourFill(spec: ColourSpec): string {
  const cs = spec.colours;
  if (spec.style === "solid" || cs.length === 1) return cs[0]!;
  if (spec.style === "gradient") return `linear-gradient(90deg, ${cs.join(", ")})`;
  const step = 100 / cs.length;
  const stops = cs.flatMap((c, i) => [`${c} ${(i * step).toFixed(2)}%`, `${c} ${((i + 1) * step).toFixed(2)}%`]);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Words for a screen reader: "gradient of #ee0979 and #ff6a00". */
export function colourLabel(spec: ColourSpec): string {
  const list = spec.colours.length <= 2 ? spec.colours.join(" and ") : `${spec.colours.slice(0, -1).join(", ")} and ${spec.colours.at(-1)}`;
  return spec.style === "solid" ? `colour ${list}` : `${spec.style === "gradient" ? "gradient" : "segments"} of ${list}`;
}

/** Several colours a product NAME plainly says: "Dual Color Red and Blue",
 *  "Tri-Color Silk Gold Silver Copper" (segments), "Gradient Blue Green", or a
 *  known colourway ("Rainbow"). Null for a single colour or a colourway name
 *  that is not a colour ("Sunset"), which stays a name, never a guess. */
export function coloursFromName(name: unknown): ColourSpec | null {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  const words = lower.split(/[^a-z]+/).filter(Boolean);
  for (const w of words) if (COLOURWAYS[w]) return COLOURWAYS[w]!;
  const colours = [...new Set(words.filter((w) => WORDS[w]).map((w) => WORDS[w]!))].slice(0, MAX_COLOURS);
  if (colours.length < 2) return null;
  if (/\bgradient\b|\bombre\b|\bfade\b/.test(lower)) return { style: "gradient", colours };
  if (/\b(dual|tri|triple|multi|two|three)[- ]?(colou?r|tone)\b|\bcoextrud/.test(lower)) return { style: "multi", colours };
  return null;
}
