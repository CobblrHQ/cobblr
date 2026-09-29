// Whether a catalog picture agrees with what the item already says it is.
//
// The automatic picture pick used to take the search's first picture that
// downloaded. For a white plastic Philips Cucina kettle, named "..., White"
// and observed as white plastic, it chose a brushed stainless-steel kettle
// with a black handle, and the card offered Add with no warning (#3584). The
// item stated two facts a picture can contradict, its colour and its
// material, and nothing compared them.
//
// Heuristic, no model. The item's words are its name and the photo
// observation (what was seen, never what a catalog said, and never the
// surface it was seen on); a candidate's are
// its listing title and its URL path. A candidate that states a colour or a
// material, where the item states one of the same kind and none of the
// candidate's matches it, CONTRADICTS the item and is never chosen
// automatically. One that states a matching one AGREES and goes first; one
// that says nothing either way keeps its place after those. A person can
// still pick any picture by hand: this governs only the unattended choice.
//
// Words are whole words (so "red" is not read in "featured"), and a material
// is a family ("stainless", "steel", "metal", "chrome" are one), so a listing
// saying "steel" contradicts an item that is "plastic" and agrees with one
// that is "stainless".

import { colourContradiction, familyOfHex, type ColourFamily } from "./picture-colour.js";

const COLOURS: Record<string, string> = {
  white: "white", ivory: "white", cream: "white",
  black: "black",
  silver: "silver",
  grey: "grey", gray: "grey", graphite: "grey", charcoal: "grey",
  red: "red", burgundy: "red", maroon: "red", crimson: "red",
  blue: "blue", navy: "blue", cobalt: "blue", indigo: "blue", sapphire: "blue", denim: "blue",
  green: "green", mint: "green", olive: "green", emerald: "green",
  pink: "pink",
  yellow: "yellow",
  orange: "orange",
  purple: "purple",
  brown: "brown",
  // The beige family: a yarn catalog's "Taupe" skein is the beige a dark
  // blue skein must never be given (#3729).
  beige: "beige", taupe: "beige", tan: "beige", camel: "beige", khaki: "beige", sand: "beige", oatmeal: "beige", fawn: "beige",
  gold: "gold",
};

const MATERIALS: Record<string, string> = {
  plastic: "plastic",
  stainless: "metal", steel: "metal", metal: "metal", chrome: "metal", aluminium: "metal", aluminum: "metal", brushed: "metal", copper: "metal",
  glass: "glass",
  wood: "wood", wooden: "wood", bamboo: "wood",
  ceramic: "ceramic", porcelain: "ceramic", stoneware: "ceramic",
  leather: "leather",
};

/** The colour and material families a text states, by whole word. */
export function statedLooks(text: string | null | undefined): { colours: Set<string>; materials: Set<string> } {
  const colours = new Set<string>();
  const materials = new Set<string>();
  for (const w of (text ?? "").toLowerCase().split(/[^a-z]+/)) {
    const c = COLOURS[w];
    if (c) colours.add(c);
    const m = MATERIALS[w];
    if (m) materials.add(m);
  }
  // A colour field's swatch value ("#000080"): the hash is required, so a
  // SKU's six digits are never read as a colour.
  for (const m of (text ?? "").matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
    const f = familyOfHex(m[0]);
    if (f) colours.add(f);
  }
  return { colours, materials };
}

// An observation describes the whole photo, so it names what the thing stands
// on as readily as the thing: "a white paperback on a wooden table", "glass
// jars on a stainless steel shelf". The surface is not the item's material, so
// a clause that places the item is dropped before its words are read.
const SETTING = /\b(?:on|upon|against|beside|behind|under|over|atop|in front of|next to|on top of)\s+(?:a|an|the|some|its|his|her|their|my)\b[^.,;:]*/gi;

/** An observation with the clauses that describe where the item sits removed. */
export function withoutSetting(observations: string | null | undefined): string {
  return (observations ?? "").replace(SETTING, " ");
}

export type PictureVerdict = { agrees: boolean; contradicts: string | null };

/** What the item says it looks like, from every place it says so. */
export interface ItemLooks {
  name?: string | null;
  observations?: string | null;
  /** Every other value the item states: its fields (Color, Colorway,
   *  Material, ...), the person's own and the lookup's alike. The name alone
   *  missed a dark-blue yarn whose name was "Charisma Yarn 3.5 oz" and whose
   *  colour lived in Color and Colorway (#3729). */
  stated?: readonly string[];
}

const valuesOf = (bag: unknown): string[] =>
  bag && typeof bag === "object" && !Array.isArray(bag)
    ? Object.values(bag as Record<string, unknown>).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []))
    : [];

/** A row's looks, read from every place it states them: the name, the photo's
 *  observation, the top candidate's fields, the person's own field values and
 *  the lookup's decoded fields. The ONE way a chooser asks, so a new place a
 *  colour can live is read by all of them at once. */
export function looksOfRow(
  row: { suggested_name?: string | null; suggested_candidates?: unknown; suggested_metadata?: unknown },
  name?: string | null,
): ItemLooks {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const cands = Array.isArray(row.suggested_candidates) ? (row.suggested_candidates as Array<{ fields?: unknown }>) : [];
  const personal = meta.user_fields && typeof meta.user_fields === "object" ? Object.values(meta.user_fields as Record<string, unknown>).flatMap(valuesOf) : [];
  return {
    name: name ?? row.suggested_name ?? null,
    observations: typeof meta.photo_observations === "string" ? meta.photo_observations : null,
    stated: [...valuesOf(cands[0]?.fields), ...personal, ...valuesOf(meta.fields), ...valuesOf(meta.decoded)],
  };
}

/** How a candidate's own words stand against the item's. `contradicts` names
 *  the clash ("says steel, the item is plastic") when there is one. */
export function pictureVerdict(item: ItemLooks, candidate: { title?: string | null; url?: string | null }): PictureVerdict {
  const mine = statedLooks(`${item.name ?? ""} ${withoutSetting(item.observations)} ${(item.stated ?? []).join(" ")}`);
  let path = candidate.url ?? "";
  try {
    path = new URL(path).pathname;
  } catch {
    /* a bare path or nothing: read as it is */
  }
  const theirs = statedLooks(`${candidate.title ?? ""} ${path}`);
  const clash = (kind: "colour" | "material", a: Set<string>, b: Set<string>): string | null =>
    a.size && b.size && ![...b].some((x) => a.has(x)) ? `says ${[...b].join("/")}, the item is ${[...a].join("/")} (${kind})` : null;
  const contradicts =
    clash("colour", mine.colours, theirs.colours) ??
    clash("material", mine.materials, theirs.materials) ??
    modelVariantClash(item.name, `${candidate.title ?? ""} ${path}`);
  const agrees = !contradicts && ([...theirs.colours].some((c) => mine.colours.has(c)) || [...theirs.materials].some((m) => mine.materials.has(m)));
  return { agrees, contradicts };
}

// ── the model ────────────────────────────────────────────────────────────
// A listing for a Creality CR-10 was given a product shot of the CR-10 V2
// (#3853): a different machine (another control box, a cable chain) that the
// search ranked first because the words overlap. A model code in the item's
// name is a fact a picture can contradict, like a colour: a picture that names
// the same code with a variant the item does not carry ("V2", "S", "Pro",
// "Max", "Mk3") is of another model. A picture that names the bare code, or
// no code at all, says nothing either way.

/** A model code: letters then digits, a dash or space allowed between
 *  ("CR-10", "A1", "P1S" reads as code P1 + variant S). */
const MODEL_CODE = /\b([a-z]{1,5})[\s-]?(\d{1,4})(?![\d.])/g;
const VARIANT = "v\\d{1,2}|mk\\s?(?:\\d{1,2}|i{1,3}v?)|pro|plus|max|mini|ultra|lite|neo|se|s\\d{0,2}|x";

const norm = (t: string): string => t.toLowerCase().replace(/[_./+]+/g, " ").replace(/\s+/g, " ");

/** What follows each model code in a text: the code ("cr10") to the variant
 *  written after it ("v2"), or "" when it stands bare. */
function codesWithVariants(text: string): Map<string, string> {
  const t = norm(text);
  const out = new Map<string, string>();
  for (const m of t.matchAll(MODEL_CODE)) {
    const code = `${m[1]}${m[2]}`;
    const rest = t.slice((m.index ?? 0) + m[0].length);
    const v = rest.match(new RegExp(`^[\\s-]?(${VARIANT})\\b`));
    const variant = v ? v[1]!.replace(/\s+/g, "") : "";
    // The first spelling a text gives a code is the one it means.
    if (!out.has(code)) out.set(code, variant);
  }
  return out;
}

/** "says CR-10 V2, the item is CR-10 (model)" when the picture names one of
 *  the item's model codes with a variant the item does not carry; null
 *  otherwise. Pure. */
export function modelVariantClash(itemName: string | null | undefined, candidateText: string): string | null {
  const mine = codesWithVariants(itemName ?? "");
  if (!mine.size) return null;
  const theirs = codesWithVariants(candidateText);
  for (const [code, variant] of mine) {
    const other = theirs.get(code);
    if (other && other !== variant) {
      return `says ${code}${other ? ` ${other}` : ""}, the item is ${code}${variant ? ` ${variant}` : ""} (model)`;
    }
  }
  return null;
}

/** The candidates the automatic pick may choose from, in the order it should
 *  try them: the contradicting ones gone, the agreeing ones first, the rest
 *  after in the search's own order. */
export function picturesThatAgree<T extends { title?: string | null; url?: string | null }>(item: ItemLooks, candidates: readonly T[]): T[] {
  const judged = candidates.map((c) => ({ c, v: pictureVerdict(item, c) })).filter((x) => !x.v.contradicts);
  return [...judged.filter((x) => x.v.agrees), ...judged.filter((x) => !x.v.agrees)].map((x) => x.c);
}

/** Every colour the row states, from every place it states one. */
export function statedColoursOf(looks: ItemLooks): Set<string> {
  return statedLooks(`${looks.name ?? ""} ${withoutSetting(looks.observations)} ${(looks.stated ?? []).join(" ")}`).colours;
}

/** Why this row's catalog picture must not be shown for it, or null: its
 *  measured colour (catalog_colour, read from the pixels when it was
 *  downloaded) against every colour the row states NOW, so a colour read
 *  from the label after the picture arrived still counts (#3729). */
export function catalogPictureContradicts(row: { suggested_name?: string | null; suggested_candidates?: unknown; suggested_metadata?: unknown; catalog_image_file_id?: string | null }): string | null {
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  // A picture the person chose is theirs, whatever it shows.
  if (meta.catalog_image_user_set) return null;
  const measured = meta.catalog_colour as { family?: string; share?: number; file_id?: string } | undefined;
  if (!measured?.family || typeof measured.share !== "number") return null;
  // A measurement speaks only for the file it measured.
  if (!row.catalog_image_file_id || measured.file_id !== row.catalog_image_file_id) return null;
  return colourContradiction(statedColoursOf(looksOfRow(row)), measured as { family: ColourFamily; share: number });
}

