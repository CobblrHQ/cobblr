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

const COLOURS: Record<string, string> = {
  white: "white", ivory: "white", cream: "white",
  black: "black",
  silver: "silver",
  grey: "grey", gray: "grey", graphite: "grey",
  red: "red", burgundy: "red",
  blue: "blue", navy: "blue",
  green: "green", mint: "green",
  pink: "pink",
  yellow: "yellow",
  orange: "orange",
  purple: "purple",
  brown: "brown",
  beige: "beige",
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

/** How a candidate's own words stand against the item's. `contradicts` names
 *  the clash ("says steel, the item is plastic") when there is one. */
export function pictureVerdict(item: { name?: string | null; observations?: string | null }, candidate: { title?: string | null; url?: string | null }): PictureVerdict {
  const mine = statedLooks(`${item.name ?? ""} ${withoutSetting(item.observations)}`);
  let path = candidate.url ?? "";
  try {
    path = new URL(path).pathname;
  } catch {
    /* a bare path or nothing: read as it is */
  }
  const theirs = statedLooks(`${candidate.title ?? ""} ${path}`);
  const clash = (kind: "colour" | "material", a: Set<string>, b: Set<string>): string | null =>
    a.size && b.size && ![...b].some((x) => a.has(x)) ? `says ${[...b].join("/")}, the item is ${[...a].join("/")} (${kind})` : null;
  const contradicts = clash("colour", mine.colours, theirs.colours) ?? clash("material", mine.materials, theirs.materials);
  const agrees = !contradicts && ([...theirs.colours].some((c) => mine.colours.has(c)) || [...theirs.materials].some((m) => mine.materials.has(m)));
  return { agrees, contradicts };
}

/** The candidates the automatic pick may choose from, in the order it should
 *  try them: the contradicting ones gone, the agreeing ones first, the rest
 *  after in the search's own order. */
export function picturesThatAgree<T extends { title?: string | null; url?: string | null }>(item: { name?: string | null; observations?: string | null }, candidates: readonly T[]): T[] {
  const judged = candidates.map((c) => ({ c, v: pictureVerdict(item, c) })).filter((x) => !x.v.contradicts);
  return [...judged.filter((x) => x.v.agrees), ...judged.filter((x) => !x.v.agrees)].map((x) => x.c);
}
